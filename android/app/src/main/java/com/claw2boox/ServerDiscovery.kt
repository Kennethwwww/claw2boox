package com.claw2boox

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Discovers claw2boox servers on the local network via mDNS/NSD.
 * Looks for services of type "_claw2boox._tcp."
 */
class ServerDiscovery(private val context: Context) {

    companion object {
        private const val TAG = "ServerDiscovery"
        private const val SERVICE_TYPE = "_claw2boox._tcp."
        private const val DISCOVERY_TIMEOUT_MS = 10_000L
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

    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {
            Log.e(TAG, "Discovery start failed: $errorCode")
            isDiscovering = false
            mainHandler.post { listener?.onDiscoveryError("Discovery failed (error $errorCode)") }
        }

        override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) {
            Log.e(TAG, "Discovery stop failed: $errorCode")
        }

        override fun onDiscoveryStarted(serviceType: String?) {
            Log.d(TAG, "Discovery started for $serviceType")
            isDiscovering = true

            // Auto-stop after timeout
            mainHandler.postDelayed({
                stopDiscovery()
                mainHandler.post {
                    listener?.onDiscoveryComplete(foundServers.values.toList())
                }
            }, DISCOVERY_TIMEOUT_MS)
        }

        override fun onDiscoveryStopped(serviceType: String?) {
            Log.d(TAG, "Discovery stopped")
            isDiscovering = false
        }

        override fun onServiceFound(serviceInfo: NsdServiceInfo?) {
            Log.d(TAG, "Service found: ${serviceInfo?.serviceName}")
            serviceInfo?.let { resolveService(it) }
        }

        override fun onServiceLost(serviceInfo: NsdServiceInfo?) {
            Log.d(TAG, "Service lost: ${serviceInfo?.serviceName}")
            serviceInfo?.serviceName?.let { name ->
                foundServers.remove(name)
                mainHandler.post { listener?.onServerLost(name) }
            }
        }
    }

    fun startDiscovery(listener: Listener) {
        this.listener = listener
        foundServers.clear()

        if (isDiscovering) {
            stopDiscovery()
        }

        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start discovery", e)
            listener.onDiscoveryError(e.message ?: "Unknown error")
        }
    }

    fun stopDiscovery() {
        if (isDiscovering) {
            try {
                nsdManager.stopServiceDiscovery(discoveryListener)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to stop discovery", e)
            }
            isDiscovering = false
        }
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

                    val server = Server(
                        name = it.serviceName,
                        host = host,
                        port = port,
                        version = attrs["version"]?.let { v -> String(v) } ?: "",
                        instanceName = attrs["instance"]?.let { v -> String(v) } ?: it.serviceName,
                    )

                    foundServers[it.serviceName] = server
                    Log.d(TAG, "Resolved: ${server.url} (${server.instanceName})")
                    mainHandler.post { listener?.onServerFound(server) }
                }
            }
        })
    }
}
