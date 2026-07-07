import React, { useState, useEffect } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  TouchableOpacity, 
  ActivityIndicator,
  Platform,
  BackHandler
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from './src/theme/colors';
import { BabyLogEntry, BabyProfile } from './src/types';
import { getLogs, getProfile, addLog, deleteLog, updateLog, saveProfile, saveLogs } from './src/database/storage';
import { syncWithCloud, uploadToCloud } from './src/database/sync';
import { Dashboard } from './src/screens/Dashboard';
import { LogFormula } from './src/screens/LogFormula';
import { LogDiaper } from './src/screens/LogDiaper';
import { Statistics } from './src/screens/Statistics';
import { Profile } from './src/screens/Profile';

function MainApp() {
  const [logs, setLogs] = useState<BabyLogEntry[]>([]);
  const [profile, setProfile] = useState<BabyProfile | null>(null);
  const [activeScreen, setActiveScreen] = useState<'dashboard' | 'formula' | 'diaper' | 'statistics' | 'profile'>('dashboard');
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  
  const insets = useSafeAreaInsets();

  // Load initial data and run background sync if syncKey is set
  useEffect(() => {
    async function loadData() {
      try {
        const loadedLogs = await getLogs();
        const loadedProfile = await getProfile();
        setLogs(loadedLogs);
        setProfile(loadedProfile);
        
        // Background sync on startup if key exists
        if (loadedProfile.syncKey) {
          const result = await syncWithCloud(loadedProfile.syncKey, loadedLogs, loadedProfile);
          if (result.success) {
            setLogs(result.logs);
            setProfile(result.profile);
          }
        }
      } catch (error) {
        console.error('Error loading initial data', error);
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, []);

  // Handle hardware back button on Android
  useEffect(() => {
    const backAction = () => {
      if (activeScreen !== 'dashboard') {
        setActiveScreen('dashboard');
        return true; // Prevent app exit
      }
      return false; // Exit app if already on dashboard
    };

    const backHandler = BackHandler.addEventListener(
      'hardwareBackPress',
      backAction
    );

    return () => backHandler.remove();
  }, [activeScreen]);

  const handleSync = async (targetSyncKey: string) => {
    if (!targetSyncKey || !targetSyncKey.trim()) return { success: false, merged: false, error: 'Empty key' };
    try {
      const currentLogs = await getLogs();
      const currentProfile = await getProfile();
      const result = await syncWithCloud(targetSyncKey.trim(), currentLogs, currentProfile);
      if (result.success) {
        setLogs(result.logs);
        setProfile(result.profile);
      }
      return { success: result.success, merged: result.merged, error: result.error };
    } catch (e) {
      console.error(e);
      return { success: false, merged: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  const handleRefresh = async () => {
    if (!profile || !profile.syncKey) return;
    setRefreshing(true);
    try {
      await handleSync(profile.syncKey);
    } catch (error) {
      console.error('Refresh sync failed', error);
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddLog = async (newLogData: Omit<BabyLogEntry, 'id'>) => {
    const savedLog = await addLog(newLogData);
    if (savedLog) {
      const updatedLogs = await getLogs();
      setLogs(updatedLogs);
      if (profile?.syncKey) {
        await uploadToCloud(profile.syncKey, updatedLogs, profile);
      }
    }
    return savedLog;
  };

  const handleDeleteLog = async (id: string) => {
    const success = await deleteLog(id);
    if (success) {
      const updatedLogs = await getLogs();
      setLogs(updatedLogs);
      if (profile?.syncKey) {
        await uploadToCloud(profile.syncKey, updatedLogs, profile);
      }
    }
  };

  const handleUpdateLog = async (updatedLog: BabyLogEntry) => {
    const success = await updateLog(updatedLog);
    if (success) {
      const updatedLogs = await getLogs();
      setLogs(updatedLogs);
      if (profile?.syncKey) {
        await uploadToCloud(profile.syncKey, updatedLogs, profile);
      }
    }
  };

  const handleSaveProfile = async (newProfile: BabyProfile) => {
    const success = await saveProfile(newProfile);
    if (success) {
      setProfile(newProfile);
      // 프로필 저장만 수행 — 동기화는 syncWithCloud를 통해 안전하게 머지 후 업로드
    }
    return success;
  };

  const handleImportData = async (newProfile: BabyProfile, newLogs: BabyLogEntry[]) => {
    await saveProfile(newProfile);
    await saveLogs(newLogs);
    setProfile(newProfile);
    setLogs(newLogs);
    setActiveScreen('dashboard');
    if (newProfile.syncKey) {
      await uploadToCloud(newProfile.syncKey, newLogs, newProfile);
    }
  };

  if (isLoading || !profile) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>우리아기 일지 로딩 중...</Text>
      </View>
    );
  }

  // Render current screen content
  const renderScreenContent = () => {
    switch (activeScreen) {
      case 'dashboard':
        return (
          <Dashboard 
            logs={logs} 
            profile={profile} 
            onDeleteLog={handleDeleteLog} 
            onUpdateLog={handleUpdateLog}
            onNavigate={setActiveScreen}
            refreshing={refreshing}
            onRefresh={profile.syncKey ? handleRefresh : undefined}
          />
        );
      case 'formula':
        return (
          <LogFormula 
            onAddLog={handleAddLog} 
            onNavigate={setActiveScreen} 
          />
        );
      case 'diaper':
        return (
          <LogDiaper 
            onAddLog={handleAddLog} 
            onNavigate={setActiveScreen} 
          />
        );
      case 'statistics':
        return <Statistics logs={logs} />;
      case 'profile':
        return (
          <Profile 
            profile={profile} 
            onSaveProfile={handleSaveProfile} 
            onImportData={handleImportData}
            onSync={handleSync}
          />
        );
    }
  };

  // Only show bottom tabs on main pages (Dashboard, Statistics, Profile)
  const showTabs = activeScreen === 'dashboard' || activeScreen === 'statistics' || activeScreen === 'profile';
  
  // Calculate dynamic bottom tab bar spacing
  const bottomPadding = insets.bottom > 0 ? insets.bottom : 8;
  const tabBarHeight = 52 + bottomPadding;

  return (
    <View style={[
      styles.container, 
      { 
        paddingTop: activeScreen === 'formula' || activeScreen === 'diaper' ? insets.top : 0
      }
    ]}>
      <StatusBar style="dark" />
      
      {/* Top Bar / App Header */}
      {showTabs && (
        <View style={[styles.header, { paddingTop: insets.top, height: 50 + insets.top }]}>
          <Text style={styles.headerTitle}>아기기록-도우미 👶</Text>
          <Text style={styles.headerSubtitle}>{profile.name} 일기</Text>
        </View>
      )}

      {/* Screen Body */}
      <View style={styles.body}>
        {renderScreenContent()}
      </View>

      {/* Custom Bottom Tab Bar */}
      {showTabs && (
        <View style={[
          styles.tabBar, 
          { 
            height: tabBarHeight, 
            paddingBottom: bottomPadding 
          }
        ]}>
          {/* Dashboard Tab */}
          <TouchableOpacity 
            style={[styles.tabItem, activeScreen === 'dashboard' && styles.tabItemActive]}
            onPress={() => setActiveScreen('dashboard')}
          >
            <Text style={styles.tabIcon}>🏠</Text>
            <Text style={[styles.tabLabel, activeScreen === 'dashboard' && styles.tabLabelActive]}>홈</Text>
          </TouchableOpacity>

          {/* Statistics Tab */}
          <TouchableOpacity 
            style={[styles.tabItem, activeScreen === 'statistics' && styles.tabItemActive]}
            onPress={() => setActiveScreen('statistics')}
          >
            <Text style={styles.tabIcon}>📈</Text>
            <Text style={[styles.tabLabel, activeScreen === 'statistics' && styles.tabLabelActive]}>통계</Text>
          </TouchableOpacity>

          {/* Profile Tab */}
          <TouchableOpacity 
            style={[styles.tabItem, activeScreen === 'profile' && styles.tabItemActive]}
            onPress={() => setActiveScreen('profile')}
          >
            <Text style={styles.tabIcon}>⚙️</Text>
            <Text style={[styles.tabLabel, activeScreen === 'profile' && styles.tabLabelActive]}>설정</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MainApp />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.background,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  header: {
    backgroundColor: COLORS.card,
    borderBottomWidth: 1,
    borderColor: COLORS.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  headerSubtitle: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  body: {
    flex: 1,
  },
  tabBar: {
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderColor: COLORS.border,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingTop: 6,
  },
  tabItem: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  tabItemActive: {
    // Add subtle visual effect if needed
  },
  tabIcon: {
    fontSize: 20,
    marginBottom: 2,
  },
  tabLabel: {
    fontSize: 11,
    color: COLORS.textMuted,
    fontWeight: 'bold',
  },
  tabLabelActive: {
    color: COLORS.primary,
  },
});
