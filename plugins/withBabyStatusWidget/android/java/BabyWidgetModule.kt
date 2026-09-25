package __PACKAGE__

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class BabyWidgetModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "BabyWidget"

  @ReactMethod
  fun updateSnapshot(snapshot: ReadableMap, promise: Promise) {
    try {
      val editor = reactApplicationContext
        .getSharedPreferences(BabyStatusWidgetProvider.PREFS_NAME, 0)
        .edit()
      val stringKeys = listOf(
        "babyName", "statusLabel", "lastFeedingLabel", "nextFeedingLabel",
        "remainingLabel", "formulaLabel", "urineLabel", "stoolLabel", "sleepLabel",
      )
      stringKeys.forEach { key ->
        if (snapshot.hasKey(key) && !snapshot.isNull(key)) editor.putString(key, snapshot.getString(key))
      }
      val nextFeedingAt = if (snapshot.hasKey("nextFeedingAt")) snapshot.getDouble("nextFeedingAt").toLong() else 0L
      editor.putLong("nextFeedingAt", nextFeedingAt)
      if (snapshot.hasKey("updatedAt")) editor.putLong("updatedAt", snapshot.getDouble("updatedAt").toLong())
      editor.apply()
      BabyStatusWidgetProvider.scheduleFeedingDueRefresh(reactApplicationContext, nextFeedingAt)
      BabyStatusWidgetProvider.updateAll(reactApplicationContext)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("BABY_WIDGET_UPDATE_FAILED", error)
    }
  }
}
