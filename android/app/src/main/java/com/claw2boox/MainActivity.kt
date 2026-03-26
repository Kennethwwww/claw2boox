package com.claw2boox

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var prefs: SharedPreferences

    companion object {
        private const val PREFS_NAME = "claw2boox_prefs"
        private const val KEY_TOKEN = "device_token"
        private const val KEY_SERVER_URL = "server_url"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Full screen for e-ink dashboard
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
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
            // E-ink: disable smooth scrolling and animations
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }

        // Inject JS bridge for device info and pairing
        webView.addJavascriptInterface(Claw2BooxBridge(), "Claw2Boox")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                // Keep all navigation within the WebView
                return false
            }
        }

        webView.webChromeClient = WebChromeClient()
    }

    private fun loadApp() {
        val token = prefs.getString(KEY_TOKEN, null)
        val serverUrl = prefs.getString(KEY_SERVER_URL, null)

        if (token != null && serverUrl != null) {
            // Already paired - load dashboard directly
            webView.loadUrl("$serverUrl/dashboard?token=${android.net.Uri.encode(token)}")
        } else {
            // Show pairing page
            // If server URL is known, go directly; otherwise show setup
            if (serverUrl != null) {
                webView.loadUrl("$serverUrl/pair")
            } else {
                // Show local setup page to enter server URL
                loadSetupPage()
            }
        }
    }

    private fun loadSetupPage() {
        val html = """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>claw2boox 初始设置</title>
            <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                html { font-family: 'Noto Sans SC', sans-serif; font-size: 18px; color: #000; background: #fff; }
                .container { max-width: 480px; margin: 80px auto; text-align: center; padding: 16px; }
                h1 { font-size: 32px; margin-bottom: 8px; }
                p { margin-bottom: 24px; font-size: 16px; }
                input { font-size: 18px; padding: 12px; border: 3px solid #000; width: 100%; margin-bottom: 16px; text-align: center; outline: none; }
                button { font-size: 20px; font-weight: 700; padding: 14px; border: 3px solid #000; background: #000; color: #fff; width: 100%; min-height: 56px; }
                button:active { background: #fff; color: #000; }
                .error { font-size: 14px; color: #000; border: 2px solid #000; padding: 8px; margin-bottom: 16px; display: none; }
                .boox-info { font-size: 13px; margin-top: 24px; border: 1px solid #000; padding: 8px; text-align: left; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>claw2boox</h1>
                <p>输入 claw2boox 服务器地址</p>
                <input type="url" id="url" placeholder="http://192.168.1.100:3000" autocomplete="off">
                <div class="error" id="error"></div>
                <button onclick="go()">连接</button>
                <div class="boox-info">
                    <strong>设备信息</strong><br>
                    制造商: <span id="mfr"></span><br>
                    型号: <span id="mdl"></span><br>
                    验证: <span id="chk"></span>
                </div>
            </div>
            <script>
                var info = JSON.parse(Claw2Boox.getDeviceInfo());
                document.getElementById('mfr').textContent = info.manufacturer;
                document.getElementById('mdl').textContent = info.model;
                document.getElementById('chk').textContent =
                    info.manufacturer.toUpperCase() === 'ONYX' ? 'BOOX 设备 ✓' : '非 BOOX 设备 ✗';

                function go() {
                    var url = document.getElementById('url').value.trim().replace(/\/+$/, '');
                    if (!url) { showError('请输入服务器地址'); return; }
                    Claw2Boox.saveServerUrl(url);
                    location.href = url + '/pair';
                }

                function showError(msg) {
                    var el = document.getElementById('error');
                    el.textContent = msg;
                    el.style.display = 'block';
                }

                document.getElementById('url').addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') go();
                });
            </script>
        </body>
        </html>
        """.trimIndent()

        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
    }

    /**
     * JavaScript interface exposed to WebView as "Claw2Boox".
     * Provides device info for BOOX verification and token persistence.
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

            return """{"manufacturer":"${escapeJson(manufacturer)}","model":"${escapeJson(model)}","serial":"${escapeJson(serial)}","displayName":"BOOX ${escapeJson(model)}"}"""
        }

        @JavascriptInterface
        fun isBooxDevice(): Boolean {
            return Build.MANUFACTURER.equals("ONYX", ignoreCase = true)
        }

        @JavascriptInterface
        fun onPaired(token: String, serverUrl: String) {
            prefs.edit()
                .putString(KEY_TOKEN, token)
                .putString(KEY_SERVER_URL, serverUrl)
                .apply()
        }

        @JavascriptInterface
        fun saveServerUrl(url: String) {
            prefs.edit()
                .putString(KEY_SERVER_URL, url)
                .apply()
        }

        @JavascriptInterface
        fun getToken(): String {
            return prefs.getString(KEY_TOKEN, "") ?: ""
        }

        @JavascriptInterface
        fun getServerUrl(): String {
            return prefs.getString(KEY_SERVER_URL, "") ?: ""
        }

        @JavascriptInterface
        fun unpair() {
            prefs.edit().clear().apply()
            runOnUiThread { loadSetupPage() }
        }

        private fun escapeJson(s: String): String {
            return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
