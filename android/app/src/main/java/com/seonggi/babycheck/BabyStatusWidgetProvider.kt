package com.seonggi.babycheck

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews

class BabyStatusWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
    appWidgetIds.forEach { manager.updateAppWidget(it, buildViews(context)) }
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == ACTION_FEEDING_DUE) updateAll(context)
  }

  companion object {
    const val PREFS_NAME = "baby_widget_snapshot"
    private const val ACTION_FEEDING_DUE = "com.seonggi.babycheck.FEEDING_DUE"

    fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val component = ComponentName(context, BabyStatusWidgetProvider::class.java)
      manager.getAppWidgetIds(component).forEach {
        manager.updateAppWidget(it, buildViews(context))
      }
    }

    fun scheduleFeedingDueRefresh(context: Context, nextFeedingAt: Long) {
      val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val intent = Intent(context, BabyStatusWidgetProvider::class.java).setAction(ACTION_FEEDING_DUE)
      val pendingIntent = PendingIntent.getBroadcast(
        context,
        7001,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      alarmManager.cancel(pendingIntent)
      if (nextFeedingAt > System.currentTimeMillis()) {
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC, nextFeedingAt, pendingIntent)
      }
    }

    private fun buildViews(context: Context): RemoteViews {
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val babyName = prefs.getString("babyName", "우리 아기") ?: "우리 아기"
      val status = prefs.getString("statusLabel", "앱에서 기록해 주세요") ?: "앱에서 기록해 주세요"
      val nextAt = prefs.getLong("nextFeedingAt", 0L)
      val now = System.currentTimeMillis()
      val views = RemoteViews(context.packageName, R.layout.baby_status_widget)

      views.setTextViewText(R.id.widget_name_status, "$babyName · $status")
      views.setTextViewText(R.id.widget_next_feeding, prefs.getString("nextFeedingLabel", "--:--"))
      views.setTextViewText(R.id.widget_last_feeding, "마지막 수유 ${prefs.getString("lastFeedingLabel", "기록 없음")}")
      views.setTextViewText(R.id.widget_formula, "🍼  ${prefs.getString("formulaLabel", "수유 기록 없음")}")
      views.setTextViewText(R.id.widget_urine, "💧  ${prefs.getString("urineLabel", "소변 기록 없음")}")
      views.setTextViewText(R.id.widget_stool, "💩  ${prefs.getString("stoolLabel", "대변 기록 없음")}")
      views.setTextViewText(R.id.widget_sleep, "😴  ${prefs.getString("sleepLabel", "수면 기록 없음")}")

      if (nextAt > now) {
        val base = SystemClock.elapsedRealtime() + (nextAt - now)
        views.setViewVisibility(R.id.widget_countdown, View.VISIBLE)
        views.setViewVisibility(R.id.widget_remaining_text, View.GONE)
        views.setChronometer(R.id.widget_countdown, base, "남은 시간 %s", true)
        views.setChronometerCountDown(R.id.widget_countdown, true)
      } else {
        views.setViewVisibility(R.id.widget_countdown, View.GONE)
        views.setViewVisibility(R.id.widget_remaining_text, View.VISIBLE)
        views.setTextViewText(
          R.id.widget_remaining_text,
          if (nextAt > 0L) "수유 시간이에요" else "수유를 기록해 주세요",
        )
      }

      views.setOnClickPendingIntent(R.id.widget_root, openApp(context, "dashboard", 7100))
      views.setOnClickPendingIntent(R.id.widget_formula, openApp(context, "formula", 7101))
      views.setOnClickPendingIntent(R.id.widget_urine, openApp(context, "diaper", 7102))
      views.setOnClickPendingIntent(R.id.widget_stool, openApp(context, "diaper", 7103))
      views.setOnClickPendingIntent(R.id.widget_sleep, openApp(context, "dashboard", 7104))
      return views
    }

    private fun openApp(context: Context, destination: String, requestCode: Int): PendingIntent {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse("babycheck://$destination")).apply {
        setPackage(context.packageName)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
      }
      return PendingIntent.getActivity(
        context,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }
}
