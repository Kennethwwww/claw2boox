package com.claw2boox

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.URL
import kotlin.concurrent.thread

/**
 * Discovers claw2boox servers on the local network via:
 * 1. mDNS/NSD (primary — looks for _claw2boox._tcp and _http._tcp)
 * 2. LAN subnet scan (fallback — probes :3000/api/discover on all IPs)
 */
class ServerDiscovery(private val context: Context) {

    companion object {
        private const val TAG = "ServerDiscovery"
        private const val SERVICE_TYPE_CUSTOM = "_claw2boox._tcp."
        private const val SERVICE_TYPE_HTTP = "_http._tcp."
        private const val DISCOVERY_TIMEOUT_MS = 8_000L
        private const val SCAN_PORT = 3000
        private const val SCAN_TIMEOUT_MS = 1500
    }

    data class Server(
        val name: String,
        val host: String,
        val port: Int,
        val version: String = "",
        val instanceName: String = "",
    ) {
        val url: String get() = "http://$host:$port"
    }

    interface Listener {
        fun onServerFound(server: Server)
        fun onServerLost(name: String)
        fun onDiscoveryComplete(servers: List<Server>)
        fun onDiscoveryError(error: String)
    }

    private val nsdManager: NsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private val foundServers = mutableMapOf<String, Server>()
    private var listener: Listener? = null
    private var isDiscovering = false
    private var nsdStartedCount = 0

    // We need separate listener instances for each service type
    private var customDiscoveryListener: NsdManager.DiscoveryListener? = null
    private var httpDiscoveryListener: NsdManager.DiscoveryListener? = null

    private fun createDiscoveryListener(): NsdManager.DiscoveryListener {
        return object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {
                Log.e(TAG, "Discovery start failed for $serviceType: $errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) {
                Log.e(TAG, "Discovery stop failed for $serviceType: $errorCode")
            }

            override fun onDiscoveryStarted(serviceType: String?) {
                Log.d(TAG, "Discovery started for $serviceType")
                nsdStartedCount++
            }

            override fun onDiscoveryStopped(serviceType: String?) {
                Log.d(TAG, "Discovery stopped for $serviceType")
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo?) {
                Log.d(TAG, "Service found: ${serviceInfo?.serviceName} (${serviceInfo?.serviceType})")
                serviceInfo?.let { resolveService(it) }
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo?) {
                serviceInfo?.serviceName?.let { name ->
                    foundServers.remove(name)
                    mainHandler.post { listener?.onServerLost(name) }
                }
            }
        }
    }

    fun startDiscovery(listener: Listener) {
        this.listener = listener
        foundServers.clear()
        isDiscovering = true
        nsdStartedCount = 0

        // Try NSD discovery with both service types
        customDiscoveryListener = createDiscoveryListener()
        httpDiscoveryListener = createDiscoveryListener()

        try {
            nsdManager.discoverServices(SERVICE_TYPE_CUSTOM, NsdManager.PROTOCOL_DNS_SD, customDiscoveryListener)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start custom NSD discovery", e)
        }

        try {
            nsdManager.discoverServices(SERVICE_TYPE_HTTP, NsdManager.PROTOCOL_DNS_SD, httpDiscoveryListener)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start HTTP NSD discovery", e)
        }

        // Start fallback network scan in parallel
        startNetworkScan()

        // Auto-complete after timeout
        mainHandler.postDelayed({
            stopDiscovery()
            listener.onDiscoveryComplete(foundServers.values.toList())
        }, DISCOVERY_TIMEOUT_MS)
    }

    fun stopDiscovery() {
        if (!isDiscovering) return
        isDiscovering = false

        customDiscoveryListener?.let {
            try { nsdManager.stopServiceDiscovery(it) } catch (e: Exception) {}
        }
        httpDiscoveryListener?.let {
            try { nsdManager.stopServiceDiscovery(it) } catch (e: Exception) {}
        }
        customDiscoveryListener = null
        httpDiscoveryListener = null
    }

    private fun resolveService(serviceInfo: NsdServiceInfo) {
        nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
            override fun onResolveFailed(si: NsdServiceInfo?, errorCode: Int) {
                Log.e(TAG, "Resolve failed for ${si?.serviceName}: $errorCode")
            }

            override fun onServiceResolved(si: NsdServiceInfo?) {
                si?.let {
                    val host = it.host?.hostAddress ?: return
                    val port = it.port
                    val attrs = it.attributes ?: emptyMap()

                    // For _http._tcp, filter: only accept if txt record says service=claw2boox
                    if (it.serviceType?.contains("http") == true) {
                        val svc = attrs["service"]?.let { v -> String(v) } ?: ""
                        if (svc != "claw2boox") return
                    }

                    val server = Server(
                        name = it.serviceName,
                        host = host,
                        port = port,
                        version = attrs["version"]?.let { v -> String(v) } ?: "",
                        instanceName = attrs["instance"]?.let { v -> String(v) } ?: it.serviceName,
                    )

                    addServer(server)
                }
            }
        })
    }

    /**
     * Fallback: scan the local subnet for claw2boox servers.
     * Probes http://<ip>:3000/api/discover on each IP.
     */
    private fun startNetworkScan() {
        thread(name = "claw2boox-scan") {
            try {
                val localIP = getLocalIPAddress() ?: return@thread
                val subnet = localIP.substringBeforeLast(".")
                Log.d(TAG, "Scanning subnet $subnet.0/24 on port $SCAN_PORT")

                // Scan common IPs in parallel batches
                val threads = mutableListOf<Thread>()
                for (i in 1..254) {
                    val ip = "$subnet.$i"
                    if (ip == localIP) continue // skip self

                    val t = thread(name = "scan-$ip") {
                        probeHost(ip, SCAN_PORT)
                    }
                    threads.add(t)

                    // Run in batches of 30 to avoid flooding
                    if (threads.size >= 30) {
                        threads.forEach { it.join(SCAN_TIMEOUT_MS.toLong() + 500) }
                        threads.clear()
                    }
                }
                threads.forEach { it.join(SCAN_TIMEOUT_MS.toLong() + 500) }
            } catch (e: Exception) {
                Log.e(TAG, "Network scan error", e)
            }
        }
    }

    private fun probeHost(ip: String, port: Int) {
        try {
            val url = URL("http://$ip:$port/api/discover")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = SCAN_TIMEOUT_MS
            conn.readTimeout = SCAN_TIMEOUT_MS
            conn.requestMethod = "GET"

            if (conn.responseCode == 200) {
                val body = conn.inputStream.bufferedReader().readText()
                if (body.contains("claw2boox")) {
                    // Parse JSON manually to avoid adding a dependency
                    val name = extractJsonString(body, "name") ?: ip
                    val version = extractJsonString(body, "version") ?: ""

                    val server = Server(
                        name = "scan-$ip",
                        host = ip,
                        port = port,
                        version = version,
                        instanceName = name,
                    )
                    addServer(server)
                }
            }
            conn.disconnect()
        } catch (e: IOException) {
            // Expected for most IPs — not a server
        } catch (e: Exception) {
            // Ignore
        }
    }

    private fun addServer(server: Server) {
        // Deduplicate by host:port
        val key = "${server.host}:${server.port}"
        if (foundServers.containsKey(key)) return

        foundServers[key] = server
        Log.d(TAG, "Found server: ${server.url} (${server.instanceName})")
        mainHandler.post { listener?.onServerFound(server) }
    }

    private fun getLocalIPAddress(): String? {
        try {
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (iface.isLoopback || !iface.isUp) continue
                for (addr in iface.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        return addr.hostAddress
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get local IP", e)
        }
        return null
    }

    private fun extractJsonString(json: String, key: String): String? {
        val pattern = "\"$key\"\\s*:\\s*\"([^\"]*)\""
        val match = Regex(pattern).find(json)
        return match?.groupValues?.get(1)
    }
}
