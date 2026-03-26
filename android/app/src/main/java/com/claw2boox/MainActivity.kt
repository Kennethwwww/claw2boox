package com.claw2boox

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var prefs: SharedPreferences
    private lateinit var discovery: ServerDiscovery
    private val discoveredServers = mutableListOf<ServerDiscovery.Server>()

    companion object {
        private const val PREFS_NAME = "claw2boox_prefs"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_SERVER_URL = "server_url"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        discovery = ServerDiscovery(this)
        webView = findViewById(R.id.webView)

        setupWebView()
        loadApp()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }

        webView.addJavascriptInterface(Claw2BooxBridge(), "Claw2Boox")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?) = false
        }
        webView.webChromeClient = WebChromeClient()
    }

    private fun loadApp() {
        val token = prefs.getString(KEY_TOKEN, null)
        val serverUrl = prefs.getString(KEY_SERVER_URL, null)

        if (token != null && serverUrl != null) {
            webView.loadUrl("$serverUrl/dashboard?token=${android.net.Uri.encode(token)}")
        } else {
            loadSetupPage()
        }
    }

    private fun loadSetupPage() {
        // Start mDNS discovery immediately
        startServerDiscovery()

        val html = """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>claw2boox</title>
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                html { font-family: 'Noto Sans SC', sans-serif; font-size: 18px; color: #000; background: #fff; }
                body { padding: 16px; }
                .container { max-width: 520px; margin: 40px auto; }
                h1 { font-size: 32px; text-align: center; margin-bottom: 4px; }
                .subtitle { text-align: center; font-size: 15px; margin-bottom: 24px; }

                /* Step indicators */
                .steps { display: flex; gap: 0; margin-bottom: 24px; border: 2px solid #000; }
                .step { flex: 1; text-align: center; padding: 10px 8px; font-size: 14px; font-weight: 700;
                        border-right: 2px solid #000; background: #fff; }
                .step:last-child { border-right: none; }
                .step.active { background: #000; color: #fff; }
                .step.done { background: #000; color: #fff; }

                /* Server list */
                .server-list { margin-bottom: 16px; }
                .server-item { border: 3px solid #000; padding: 14px; margin-bottom: 8px; cursor: pointer;
                               display: flex; justify-content: space-between; align-items: center; }
                .server-item:active, .server-item.selected { background: #000; color: #fff; }
                .server-name { font-weight: 700; font-size: 18px; }
                .server-url { font-size: 13px; margin-top: 2px; }
                .server-status { font-size: 12px; font-weight: 700; }

                .scanning { text-align: center; padding: 20px; border: 2px dashed #000; margin-bottom: 16px;
                            font-size: 16px; }
                .scanning .dots::after { content: ''; animation: dots 1.5s steps(4,end) infinite; }
                @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }

                .manual-toggle { font-size: 14px; text-align: center; margin: 12px 0; cursor: pointer;
                                 text-decoration: underline; }

                .manual-input { display: none; margin-bottom: 16px; }
                .manual-input.visible { display: block; }
                .manual-input input { font-size: 16px; padding: 10px; border: 2px solid #000; width: 100%;
                                      text-align: center; outline: none; }

                /* Pairing code input */
                .pair-section { display: none; }
                .pair-section.visible { display: block; }
                .pair-label { font-size: 15px; margin-bottom: 8px; font-weight: 700; }
                .pair-input { font-size: 28px; padding: 14px; border: 3px solid #000; width: 100%;
                              text-align: center; letter-spacing: 10px; font-weight: 700; outline: none;
                              margin-bottom: 16px; }

                .btn { font-size: 18px; font-weight: 700; padding: 14px; border: 3px solid #000;
                       background: #000; color: #fff; width: 100%; min-height: 52px; cursor: pointer; }
                .btn:active { background: #fff; color: #000; }
                .btn:disabled { background: #fff; color: #999; border-style: dashed; }
                .btn-secondary { background: #fff; color: #000; margin-top: 8px; }
                .btn-secondary:active { background: #000; color: #fff; }

                .error { font-size: 14px; font-weight: 700; border: 2px solid #000; padding: 10px;
                         margin-bottom: 12px; display: none; text-align: center; }
                .error.visible { display: block; }

                .success { text-align: center; padding: 24px; border: 3px solid #000; background: #000;
                           color: #fff; font-size: 20px; font-weight: 700; }

                .device-info { font-size: 12px; margin-top: 20px; border-top: 1px solid #000; padding-top: 8px;
                               text-align: center; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>claw2boox</h1>
                <p class="subtitle">BOOX × OpenClaw</p>

                <div class="steps">
                    <div class="step active" id="step1">① 发现服务</div>
                    <div class="step" id="step2">② 输入配对码</div>
                    <div class="step" id="step3">③ 完成</div>
                </div>

                <!-- Step 1: Find Server -->
                <div id="findSection">
                    <div class="scanning" id="scanStatus">
                        正在搜索局域网内的 claw2boox 服务<span class="dots"></span>
                    </div>

                    <div class="server-list" id="serverList"></div>

                    <div class="manual-toggle" onclick="toggleManual()">手动输入服务器地址</div>
                    <div class="manual-input" id="manualInput">
                        <input type="url" id="manualUrl" placeholder="http://192.168.1.100:3000" autocomplete="off">
                    </div>

                    <button class="btn" id="connectBtn" onclick="connectToServer()" disabled>连接</button>
                    <button class="btn btn-secondary" onclick="rescan()">重新搜索</button>
                </div>

                <!-- Step 2: Enter Pairing Code -->
                <div class="pair-section" id="pairSection">
                    <p class="pair-label">在 OpenClaw 终端中查看 6 位配对码，输入到下方：</p>
                    <div class="error" id="pairError"></div>
                    <input type="text" class="pair-input" id="pairCode" placeholder="000000"
                           maxlength="6" inputmode="numeric" pattern="[0-9]*" autocomplete="off">
                    <button class="btn" id="pairBtn" onclick="doPair()">配对</button>
                    <button class="btn btn-secondary" onclick="backToFind()">返回</button>
                </div>

                <!-- Step 3: Success -->
                <div class="pair-section" id="successSection">
                    <div class="success">
                        <p>配对成功</p>
                        <p id="deviceName" style="font-size:14px; margin-top:8px;"></p>
                    </div>
                    <p style="text-align:center; margin-top:12px; font-size:14px;">正在跳转到仪表板...</p>
                </div>

                <div class="device-info" id="deviceInfo"></div>
            </div>

            <script>
                var selectedServer = null;
                var servers = [];

                // Show device info
                (function() {
                    try {
                        var info = JSON.parse(Claw2Boox.getDeviceInfo());
                        var el = document.getElementById('deviceInfo');
                        var isBoox = info.manufacturer.toUpperCase() === 'ONYX';
                        el.textContent = info.manufacturer + ' ' + info.model +
                            (isBoox ? ' (BOOX ✓)' : ' (非BOOX设备)');
                    } catch(e) {}
                })();

                // Server discovery via NSD bridge
                function pollDiscovery() {
                    try {
                        var json = Claw2Boox.getDiscoveredServers();
                        var list = JSON.parse(json);
                        for (var i = 0; i < list.length; i++) {
                            addServer(list[i]);
                        }
                    } catch(e) {}
                }

                var discoveryPoll = setInterval(pollDiscovery, 1500);
                setTimeout(function() {
                    clearInterval(discoveryPoll);
                    pollDiscovery(); // one last poll
                    if (servers.length === 0) {
                        document.getElementById('scanStatus').innerHTML =
                            '未找到服务。请确认服务端已启动，或手动输入地址。';
                    } else {
                        document.getElementById('scanStatus').style.display = 'none';
                    }
                }, 12000);

                function addServer(s) {
                    // Deduplicate
                    for (var i = 0; i < servers.length; i++) {
                        if (servers[i].url === s.url) return;
                    }
                    servers.push(s);
                    document.getElementById('scanStatus').style.display = 'none';

                    var list = document.getElementById('serverList');
                    var div = document.createElement('div');
                    div.className = 'server-item';
                    div.setAttribute('data-url', s.url);
                    div.innerHTML = '<div><div class="server-name">' + esc(s.instanceName || s.name) + '</div>' +
                        '<div class="server-url">' + esc(s.url) + '</div></div>' +
                        '<div class="server-status">▸</div>';
                    div.onclick = function() {
                        // Deselect all
                        var items = list.querySelectorAll('.server-item');
                        for (var j = 0; j < items.length; j++) items[j].classList.remove('selected');
                        div.classList.add('selected');
                        selectedServer = s.url;
                        document.getElementById('connectBtn').disabled = false;
                    };
                    list.appendChild(div);

                    // Auto-select if only one server
                    if (servers.length === 1) {
                        div.onclick();
                    }
                }

                function toggleManual() {
                    var el = document.getElementById('manualInput');
                    el.classList.toggle('visible');
                    if (el.classList.contains('visible')) {
                        document.getElementById('manualUrl').focus();
                        document.getElementById('connectBtn').disabled = false;
                    }
                }

                function rescan() {
                    servers = [];
                    document.getElementById('serverList').innerHTML = '';
                    document.getElementById('scanStatus').innerHTML =
                        '正在搜索局域网内的 claw2boox 服务<span class="dots"></span>';
                    document.getElementById('scanStatus').style.display = 'block';
                    document.getElementById('connectBtn').disabled = true;
                    selectedServer = null;
                    try { Claw2Boox.restartDiscovery(); } catch(e) {}
                    discoveryPoll = setInterval(pollDiscovery, 1500);
                    setTimeout(function() {
                        clearInterval(discoveryPoll);
                        pollDiscovery();
                        if (servers.length === 0) {
                            document.getElementById('scanStatus').innerHTML =
                                '未找到服务。请确认服务端已启动，或手动输入地址。';
                        }
                    }, 12000);
                }

                function connectToServer() {
                    var url = selectedServer;
                    var manual = document.getElementById('manualUrl').value.trim().replace(/\/+$/, '');
                    if (manual) url = manual;
                    if (!url) return;

                    try { Claw2Boox.saveServerUrl(url); } catch(e) {}

                    // Move to step 2
                    document.getElementById('findSection').style.display = 'none';
                    document.getElementById('pairSection').classList.add('visible');
                    document.getElementById('step1').className = 'step done';
                    document.getElementById('step2').className = 'step active';
                    document.getElementById('pairCode').focus();
                }

                function backToFind() {
                    document.getElementById('pairSection').classList.remove('visible');
                    document.getElementById('findSection').style.display = 'block';
                    document.getElementById('step1').className = 'step active';
                    document.getElementById('step2').className = 'step';
                }

                function showPairError(msg) {
                    var el = document.getElementById('pairError');
                    el.textContent = msg;
                    el.classList.add('visible');
                }

                async function doPair() {
                    document.getElementById('pairError').classList.remove('visible');

                    var code = document.getElementById('pairCode').value.trim();
                    if (!/^\d{6}$/.test(code)) {
                        showPairError('请输入 6 位数字配对码');
                        return;
                    }

                    var btn = document.getElementById('pairBtn');
                    btn.disabled = true;
                    btn.textContent = '配对中...';

                    var serverUrl = '';
                    try { serverUrl = Claw2Boox.getServerUrl(); } catch(e) {}
                    if (!serverUrl) serverUrl = selectedServer;

                    var deviceInfo;
                    try { deviceInfo = JSON.parse(Claw2Boox.getDeviceInfo()); } catch(e) {
                        deviceInfo = { manufacturer: 'UNKNOWN', model: 'UNKNOWN', serial: '' };
                    }

                    try {
                        var res = await fetch(serverUrl + '/api/pair/verify', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ code: code, device: deviceInfo }),
                        });
                        var data = await res.json();

                        if (!res.ok || data.error) {
                            showPairError(data.error || '配对失败');
                            btn.disabled = false;
                            btn.textContent = '配对';
                            return;
                        }

                        localStorage.setItem('claw2boox_token', data.token);
                        try { Claw2Boox.onPaired(data.token, serverUrl); } catch(e) {}

                        // Step 3: Success
                        document.getElementById('pairSection').classList.remove('visible');
                        document.getElementById('successSection').classList.add('visible');
                        document.getElementById('deviceName').textContent = data.display_name;
                        document.getElementById('step2').className = 'step done';
                        document.getElementById('step3').className = 'step active';

                        setTimeout(function() {
                            location.href = serverUrl + '/dashboard?token=' + encodeURIComponent(data.token);
                        }, 2000);

                    } catch (err) {
                        showPairError('无法连接服务器: ' + err.message);
                        btn.disabled = false;
                        btn.textContent = '配对';
                    }
                }

                document.getElementById('pairCode').addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') doPair();
                });

                function esc(s) {
                    var d = document.createElement('div');
                    d.textContent = s;
                    return d.innerHTML;
                }
            </script>
        </body>
        </html>
        """.trimIndent()

        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }

    private fun startServerDiscovery() {
        discoveredServers.clear()
        discovery.startDiscovery(object : ServerDiscovery.Listener {
            override fun onServerFound(server: ServerDiscovery.Server) {
                discoveredServers.add(server)
            }
            override fun onServerLost(name: String) {
                discoveredServers.removeAll { it.name == name }
            }
            override fun onDiscoveryComplete(servers: List<ServerDiscovery.Server>) {
                // Discovery results are polled via JS bridge
            }
            override fun onDiscoveryError(error: String) {
                Log.e("MainActivity", "Discovery error: $error")
            }
        })
    }

    /**
     * JavaScript interface exposed to WebView as "Claw2Boox".
     */
    inner class Claw2BooxBridge {

        @JavascriptInterface
        fun getDeviceInfo(): String {
            val manufacturer = Build.MANUFACTURER ?: "UNKNOWN"
            val model = Build.MODEL ?: "UNKNOWN"
            val serial = try {
                Build.getSerial()
            } catch (e: SecurityException) {
                Build.FINGERPRINT
            }
            return """{"manufacturer":"${esc(manufacturer)}","model":"${esc(model)}","serial":"${esc(serial)}","displayName":"BOOX ${esc(model)}"}"""
        }

        @JavascriptInterface
        fun isBooxDevice(): Boolean = Build.MANUFACTURER.equals("ONYX", ignoreCase = true)

        @JavascriptInterface
        fun getDiscoveredServers(): String {
            val arr = JSONArray()
            for (s in discoveredServers) {
                val obj = JSONObject()
                obj.put("name", s.name)
                obj.put("url", s.url)
                obj.put("instanceName", s.instanceName)
                obj.put("version", s.version)
                arr.put(obj)
            }
            return arr.toString()
        }

        @JavascriptInterface
        fun restartDiscovery() {
            runOnUiThread { startServerDiscovery() }
        }

        @JavascriptInterface
        fun onPaired(token: String, serverUrl: String) {
            prefs.edit().putString(KEY_TOKEN, token).putString(KEY_SERVER_URL, serverUrl).apply()
        }

        @JavascriptInterface
        fun saveServerUrl(url: String) {
            prefs.edit().putString(KEY_SERVER_URL, url).apply()
        }

        @JavascriptInterface
        fun getToken(): String = prefs.getString(KEY_TOKEN, "") ?: ""

        @JavascriptInterface
        fun getServerUrl(): String = prefs.getString(KEY_SERVER_URL, "") ?: ""

        @JavascriptInterface
        fun unpair() {
            prefs.edit().clear().apply()
            runOnUiThread { loadSetupPage() }
        }

        private fun esc(s: String): String {
            return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r")
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        discovery.stopDiscovery()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
