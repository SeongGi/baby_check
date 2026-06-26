import React, { useState, useEffect } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  SafeAreaView, 
  TouchableOpacity, 
  ActivityIndicator,
  Platform,
  NativeModules
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { COLORS } from './src/theme/colors';
import { BabyLogEntry, BabyProfile } from './src/types';
import { getLogs, getProfile, addLog, deleteLog, saveProfile } from './src/database/storage';
import { Dashboard } from './src/screens/Dashboard';
import { LogFormula } from './src/screens/LogFormula';
import { LogDiaper } from './src/screens/LogDiaper';
import { Statistics } from './src/screens/Statistics';
import { Profile } from './src/screens/Profile';

export default function App() {
  const [logs, setLogs] = useState<BabyLogEntry[]>([]);
  const [profile, setProfile] = useState<BabyProfile | null>(null);
  const [activeScreen, setActiveScreen] = useState<'dashboard' | 'formula' | 'diaper' | 'statistics' | 'profile'>('dashboard');
  const [isLoading, setIsLoading] = useState(true);

  // Load initial data
  useEffect(() => {
    async function loadData() {
      try {
        const loadedLogs = await getLogs();
        const loadedProfile = await getProfile();
        setLogs(loadedLogs);
        setProfile(loadedProfile);
      } catch (error) {
        console.error('Error loading data', error);
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, []);

  const handleAddLog = async (newLogData: Omit<BabyLogEntry, 'id'>) => {
    const savedLog = await addLog(newLogData);
    if (savedLog) {
      // Reload logs from storage to keep in sync and sorted
      const updatedLogs = await getLogs();
      setLogs(updatedLogs);
    }
    return savedLog;
  };

  const handleDeleteLog = async (id: string) => {
    const success = await deleteLog(id);
    if (success) {
      const updatedLogs = await getLogs();
      setLogs(updatedLogs);
    }
  };

  const handleSaveProfile = async (newProfile: BabyProfile) => {
    const success = await saveProfile(newProfile);
    if (success) {
      setProfile(newProfile);
    }
    return success;
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
            onNavigate={setActiveScreen} 
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
          />
        );
    }
  };

  // Only show bottom tabs on main pages (Dashboard, Statistics, Profile)
  const showTabs = activeScreen === 'dashboard' || activeScreen === 'statistics' || activeScreen === 'profile';

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      
      {/* Top Bar / App Header */}
      {showTabs && (
        <View style={styles.header}>
          <Text style={styles.headerTitle}>아가보개 👶</Text>
          <Text style={styles.headerSubtitle}>{profile.name} 일기</Text>
        </View>
      )}

      {/* Screen Body */}
      <View style={styles.body}>
        {renderScreenContent()}
      </View>

      {/* Custom Bottom Tab Bar */}
      {showTabs && (
        <View style={styles.tabBar}>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    // Add extra padding for android top bar if not covered by safearea
    paddingTop: Platform.OS === 'android' ? 35 : 0,
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
    height: 55,
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
    height: 64,
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderColor: COLORS.border,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingBottom: Platform.OS === 'ios' ? 12 : 6,
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
