# Multicord for Android: R8 rules for the release build, on top of proguard-android-optimize.txt and the
# libraries' own consumer rules (androidx.webkit, androidx.browser, OkHttp, kotlinx.serialization).
#
# What R8 cannot see, and so must be told:
# - Activities, the service and the receivers are kept through the manifest.
# - Pages talk to native code only through WebMessageListener (androidx.webkit) and JSON strings; there is
#   no @JavascriptInterface and no reflection over our classes, so nothing of ours needs keeping by name.
# - kotlinx.serialization is used only through its JsonElement tree (no @Serializable classes, no compiler
#   plugin), which needs no rules of its own.
#
# Crash logs (under the tag "Multicord") keep line numbers, with source file names hidden.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
