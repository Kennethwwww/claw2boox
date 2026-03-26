# Keep JS interface for WebView bridge
-keepclassmembers class com.claw2boox.MainActivity$Claw2BooxBridge {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep class names for debugging
-keepattributes SourceFile,LineNumberTable
