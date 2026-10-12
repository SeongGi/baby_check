import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { BabyLogEntry } from '../types';
import { parseVoiceCommand, VoiceCommand } from '../utils/voiceCommand';
import { getVoiceStatusText, VoicePhase } from '../utils/voiceFeedback';

type Props = {
  logs: BabyLogEntry[];
  onAddLog: (log: Omit<BabyLogEntry, 'id'>) => Promise<unknown>;
  onUpdateLog: (log: BabyLogEntry) => Promise<boolean>;
  autoVoiceEnabled: boolean;
  onAutoVoiceEnabledChange: (enabled: boolean) => Promise<void>;
  autoStartRequest: number;
  onAutoStartHandled: (request: number) => void;
  onRecognitionActivity: (active: boolean) => void;
};

export const VoiceLogButton: React.FC<Props> = ({ logs, onAddLog, onUpdateLog, autoVoiceEnabled, onAutoVoiceEnabledChange, autoStartRequest, onAutoStartHandled, onRecognitionActivity }) => {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [command, setCommand] = useState<VoiceCommand | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [savedSummary, setSavedSummary] = useState<string | null>(null);
  const [showExamples, setShowExamples] = useState(false);
  const [foregroundRevision, setForegroundRevision] = useState(0);
  const [attemptRevision, setAttemptRevision] = useState(0);

  const starting = useRef(false);
  const mounted = useRef(true);
  const interrupted = useRef(false);
  const listeningRef = useRef(false);
  const nativeSessionOpenRef = useRef(false);
  const terminalEventRef = useRef<'none' | 'result' | 'error'>('none');
  const permissionPromptRef = useRef(false);
  const resumeAfterPermissionRef = useRef(false);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startGeneration = useRef(0);
  const handledAutoRequestRef = useRef(0);
  const savePendingRef = useRef(false);
  const logsRef = useRef(logs);
  logsRef.current = logs;

  const completeAutoRequest = (request: number) => {
    if (handledAutoRequestRef.current === request) return;
    handledAutoRequestRef.current = request;
    onAutoStartHandled(request);
  };

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setForegroundRevision(revision => revision + 1);
        return;
      }
      if (state !== 'background' || permissionPromptRef.current) return;
      const hasFinalResult = terminalEventRef.current === 'result';
      if (!hasFinalResult) {
        interrupted.current = true;
        startGeneration.current += 1;
      }
      if (nativeSessionOpenRef.current) ExpoSpeechRecognitionModule.abort();
      starting.current = false;
      if (nativeSessionOpenRef.current && !hasFinalResult) {
        terminalEventRef.current = 'error';
        setPhase('error');
        setStatusMessage('앱이 뒤로 이동해 음성 입력을 중단했어요. 홈에서 다시 눌러 주세요.');
      }
      onRecognitionActivity(false);
      setAttemptRevision(revision => revision + 1);
    });
    return () => {
      mounted.current = false;
      interrupted.current = true;
      startGeneration.current += 1;
      subscription.remove();
      if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (nativeSessionOpenRef.current) ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  const getCommandDescription = (cmd: VoiceCommand | null): string | null => {
    if (!cmd || cmd.kind === 'unknown') return null;
    switch (cmd.kind) {
      case 'formula':
        return `${cmd.feedingType === 'breast' ? '모유' : cmd.feedingType === 'mixed' ? '혼합 수유' : '분유'} ${cmd.amount}ml 기록`;
      case 'urine':
        return `소변 기록 (${cmd.wetness === 'light' ? '적음' : cmd.wetness === 'heavy' ? '많음' : '보통'})`;
      case 'stool':
        return `대변 기록 (${cmd.color === 'yellow' ? '황금색' : cmd.color === 'green' ? '녹색' : cmd.color === 'brown' ? '갈색' : cmd.color === 'red' ? '적색' : cmd.color === 'black' ? '흑색' : '회색'})`;
      case 'bath':
        return `${cmd.bathType === 'quick' ? '간단 씻기' : '목욕'} ${cmd.durationMinutes}분 기록`;
      case 'weight':
        return `체중 ${cmd.weightKg}kg 기록`;
      case 'sleepStart':
        return '수면 시작 기록';
      case 'sleepEnd':
        return '수면 종료 기록';
      case 'tummyStart':
        return '터미타임 시작 기록';
      case 'tummyEnd':
        return '터미타임 종료 기록';
      case 'playStart':
        return '놀기시간 시작 기록';
      case 'playEnd':
        return '놀기시간 종료 기록';
    }
  };

  const executeAutoSave = async (parsed: VoiceCommand, timestamp: number) => {
    if (parsed.kind === 'unknown' || savePendingRef.current) return;

    const timedType = parsed.kind.startsWith('sleep')
      ? 'sleep'
      : parsed.kind.startsWith('tummy')
      ? 'tummyTime'
      : parsed.kind.startsWith('play')
      ? 'play'
      : null;
    const ending = parsed.kind.endsWith('End');
    const active = timedType
      ? logsRef.current.filter(log => log.type === timedType && log.endedAt == null).sort((a, b) => b.timestamp - a.timestamp)[0]
      : undefined;

    if (timedType && ((ending && (!active || active.timestamp > timestamp)) || (!ending && active))) {
      setPhase('error');
      const err = ending ? '종료할 진행 중인 기록이 없습니다.' : '이미 진행 중인 기록이 있습니다.';
      setStatusMessage(err);
      return;
    }

    savePendingRef.current = true;
    setBusy(true);
    setPhase('saving');
    setStatusMessage('기록을 저장하고 있어요…');

    try {
      let result: unknown = null;
      if (parsed.kind === 'formula') {
        result = await onAddLog({
          type: 'formula',
          feedingType: parsed.feedingType ?? 'formula',
          amount: parsed.amount,
          formulaAmount: parsed.formulaAmount,
          breastAmount: parsed.breastAmount,
          temperature: parsed.temperature,
          timestamp,
        } as Omit<BabyLogEntry, 'id'>);
      } else if (parsed.kind === 'urine') {
        result = await onAddLog({
          type: 'urine',
          wetness: parsed.wetness,
          color: parsed.color,
          timestamp,
        } as Omit<BabyLogEntry, 'id'>);
      } else if (parsed.kind === 'stool') {
        result = await onAddLog({
          type: 'stool',
          color: parsed.color,
          consistency: parsed.consistency,
          amount: parsed.amount,
          timestamp,
        } as Omit<BabyLogEntry, 'id'>);
      } else if (parsed.kind === 'bath') {
        result = await onAddLog({
          type: 'bath',
          bathType: parsed.bathType,
          durationMinutes: parsed.durationMinutes,
          timestamp,
        } as Omit<BabyLogEntry, 'id'>);
      } else if (parsed.kind === 'weight') {
        result = await onAddLog({
          type: 'weight',
          weightKg: parsed.weightKg,
          timestamp,
        } as Omit<BabyLogEntry, 'id'>);
      } else if (ending && active) {
        result = await onUpdateLog({ ...active, endedAt: timestamp } as BabyLogEntry);
      } else if (timedType) {
        result = await onAddLog({ type: timedType, timestamp } as Omit<BabyLogEntry, 'id'>);
      }

      if (result === null || result === false) throw new Error('save failed');

      const desc = getCommandDescription(parsed);
      setSavedSummary(desc);
      setPhase('saved');
      setStatusMessage(`✨ ${desc} 저장 완료!`);

      // 3.5초 후 자동으로 초기화 복귀
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => {
        if (!mounted.current) return;
        setTranscript('');
        setCommand(null);
        setSavedSummary(null);
        setPhase('idle');
        setStatusMessage(null);
      }, 3500);
    } catch {
      setPhase('error');
      setStatusMessage('기록 저장 도중 오류가 발생했습니다. 다시 시도해 주세요.');
    } finally {
      savePendingRef.current = false;
      setBusy(false);
    }
  };

  useSpeechRecognitionEvent('start', () => {
    if (!nativeSessionOpenRef.current) return;
    if (interrupted.current || AppState.currentState === 'background') {
      ExpoSpeechRecognitionModule.abort();
      return;
    }
    listeningRef.current = true;
    setListening(true);
    setPhase('listening');
    setStatusMessage(null);
  });

  useSpeechRecognitionEvent('end', () => {
    if (!nativeSessionOpenRef.current) return;
    nativeSessionOpenRef.current = false;
    onRecognitionActivity(false);
    listeningRef.current = false;
    setListening(false);
    starting.current = false;
    if (terminalEventRef.current === 'none') {
      setPhase('error');
      setStatusMessage('말소리를 듣지 못했어요. 음성 버튼을 다시 눌러 주세요.');
    }
    setAttemptRevision(revision => revision + 1);
  });

  useSpeechRecognitionEvent('result', event => {
    if (!event.isFinal || interrupted.current || !nativeSessionOpenRef.current || terminalEventRef.current !== 'none') return;
    terminalEventRef.current = 'result';
    const recognized = event.results[0]?.transcript?.trim() || '';
    const parsed = parseVoiceCommand(recognized);
    const time = Date.now();
    setTranscript(recognized);
    setCommand(parsed);
    setPhase('processing');
    setStatusMessage('명령을 처리 중이에요…');

    const generation = startGeneration.current;
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
    processingTimerRef.current = setTimeout(() => {
      processingTimerRef.current = null;
      if (!mounted.current || generation !== startGeneration.current) return;

      if (parsed.kind === 'unknown') {
        setPhase('error');
        setStatusMessage('명령을 이해하지 못했어요. 아래 명령어 예시를 참고해 주세요.');
      } else {
        // 유효한 명령이면 확인 클릭 없이 즉시 저장
        void executeAutoSave(parsed, time);
      }
    }, 250);
  });

  useSpeechRecognitionEvent('error', event => {
    if (!nativeSessionOpenRef.current || terminalEventRef.current !== 'none') return;
    terminalEventRef.current = 'error';
    onRecognitionActivity(false);
    setListening(false);
    starting.current = false;
    setPhase('error');
    setAttemptRevision(revision => revision + 1);
    setStatusMessage(event.error === 'aborted'
      ? '음성 입력이 중단됐어요. 다시 눌러 주세요.'
      : event.error === 'no-speech' || event.error === 'speech-timeout'
        ? '말소리를 듣지 못했어요. 음성 버튼을 다시 눌러 주세요.'
        : `음성 인식 오류 (${event.error}): ${event.message || '기기의 음성 인식 서비스를 확인해 주세요.'}`);
  });

  const start = async (): Promise<'handled' | 'deferred'> => {
    if (savePendingRef.current || starting.current || nativeSessionOpenRef.current) return 'deferred';
    if (AppState.currentState !== 'active') {
      setPhase('error');
      setStatusMessage('앱이 화면에 있을 때 음성 버튼을 다시 눌러 주세요.');
      return 'deferred';
    }
    starting.current = true;
    onRecognitionActivity(true);
    interrupted.current = false;
    const generation = ++startGeneration.current;
    if (processingTimerRef.current) clearTimeout(processingTimerRef.current);
    processingTimerRef.current = null;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;

    terminalEventRef.current = 'none';
    resumeAfterPermissionRef.current = false;
    setPhase('starting');
    setTranscript('');
    setCommand(null);
    setSavedSummary(null);
    setStatusMessage('음성 인식을 준비하고 있어요…');
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        const message = '기기의 음성 인식 서비스를 사용할 수 없습니다. Google 음성 인식 서비스가 설치·활성화되어 있는지 확인해 주세요.';
        setStatusMessage(message);
        setPhase('error');
        starting.current = false;
        onRecognitionActivity(false);
        return 'handled';
      }
      let permission = await ExpoSpeechRecognitionModule.getPermissionsAsync();
      if (!permission.granted) {
        permissionPromptRef.current = true;
        permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        permissionPromptRef.current = false;
      }
      if (!mounted.current || interrupted.current || generation !== startGeneration.current) {
        if (generation === startGeneration.current) starting.current = false;
        onRecognitionActivity(false);
        return 'deferred';
      }
      if (!permission.granted) {
        const message = '음성 기록을 사용하려면 앱 설정에서 마이크 권한을 허용해 주세요.';
        setStatusMessage(message);
        setPhase('error');
        starting.current = false;
        onRecognitionActivity(false);
        return 'handled';
      }
      if (AppState.currentState !== 'active') {
        starting.current = false;
        resumeAfterPermissionRef.current = true;
        setStatusMessage('앱으로 돌아오면 음성 입력을 시작할게요…');
        onRecognitionActivity(false);
        return 'deferred';
      }
      nativeSessionOpenRef.current = true;
      ExpoSpeechRecognitionModule.start({ lang: 'ko-KR', interimResults: false, continuous: false });
      return 'handled';
    } catch {
      permissionPromptRef.current = false;
      if (!mounted.current || interrupted.current || generation !== startGeneration.current) {
        if (generation === startGeneration.current) starting.current = false;
        onRecognitionActivity(false);
        return 'deferred';
      }
      if (AppState.currentState !== 'active') {
        starting.current = false;
        resumeAfterPermissionRef.current = true;
        setStatusMessage('앱으로 돌아오면 음성 입력을 다시 시도할게요…');
        onRecognitionActivity(false);
        return 'deferred';
      }
      if (generation === startGeneration.current) {
        nativeSessionOpenRef.current = false;
        starting.current = false;
        onRecognitionActivity(false);
        if (mounted.current) {
          const message = '이 기기에서 음성 인식을 시작하지 못했습니다. 마이크 권한과 음성 인식 서비스를 확인해 주세요.';
          setStatusMessage(message);
          setPhase('error');
        }
      }
      return 'handled';
    } finally {
      if (!starting.current && mounted.current) setAttemptRevision(revision => revision + 1);
    }
  };

  useEffect(() => {
    if (!resumeAfterPermissionRef.current || AppState.currentState !== 'active') return;
    resumeAfterPermissionRef.current = false;
    void start();
  }, [foregroundRevision]);

  useEffect(() => {
    if (!autoStartRequest) return;
    if (handledAutoRequestRef.current === autoStartRequest) return;
    if (savePendingRef.current) return;
    if (!autoVoiceEnabled || transcript || command) {
      completeAutoRequest(autoStartRequest);
      return;
    }
    if (!mounted.current || AppState.currentState !== 'active') return;
    if (nativeSessionOpenRef.current || starting.current) {
      completeAutoRequest(autoStartRequest);
      return;
    }
    completeAutoRequest(autoStartRequest);
    void start();
  }, [autoStartRequest, autoVoiceEnabled, foregroundRevision, attemptRevision, busy]);

  const voiceStatusText = getVoiceStatusText(phase, statusMessage);

  useEffect(() => {
    if (Platform.OS === 'ios' && phase !== 'idle') AccessibilityInfo.announceForAccessibility(voiceStatusText);
  }, [phase, voiceStatusText]);

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={[
          styles.button,
          phase === 'saved' ? styles.buttonSaved : phase === 'saving' ? styles.buttonSaving : null,
        ]}
        disabled={busy || phase === 'starting' || phase === 'processing' || phase === 'saving'}
        onPress={listening ? () => {
          setPhase('processing');
          setStatusMessage('명령을 처리 중이에요…');
          ExpoSpeechRecognitionModule.stop();
        } : () => {
          if (autoStartRequest) completeAutoRequest(autoStartRequest);
          void start();
        }}
        accessibilityLabel={listening ? '음성 입력 끝내기' : '음성으로 기록하기'}
      >
        <Text style={styles.buttonText}>
          {phase === 'starting'
            ? '마이크 준비 중…'
            : listening
            ? '듣고 있어요… 탭하여 끝내기'
            : phase === 'processing'
            ? '명령 처리 중…'
            : phase === 'saving'
            ? '기록 저장 중…'
            : phase === 'saved'
            ? '✓ 저장 완료'
            : '🎤 음성으로 바로 기록하기'}
        </Text>
      </TouchableOpacity>

      <Text accessibilityLiveRegion="polite" style={styles.voiceStatus}>{voiceStatusText}</Text>

      {transcript ? <Text style={styles.transcript}>인식: "{transcript}"</Text> : null}

      {/* 실시간 피드백 완료 카드 */}
      {phase === 'saved' && savedSummary ? (
        <View style={styles.savedBanner}>
          <Text style={styles.savedTitle}>🎉 기록이 성공적으로 저장되었습니다</Text>
          <Text style={styles.savedDesc}>{savedSummary}</Text>
        </View>
      ) : null}

      {/* 사용 가능한 명령어 가이드 */}
      <View style={styles.guideContainer}>
        <TouchableOpacity
          style={styles.guideHeader}
          onPress={() => setShowExamples(prev => !prev)}
          accessibilityRole="button"
        >
          <Text style={styles.guideTitle}>💡 사용 가능한 음성 명령어 예시 {showExamples ? '▲ 접기' : '▼ 보기'}</Text>
        </TouchableOpacity>

        {showExamples ? (
          <View style={styles.examplesList}>
            <View style={styles.exampleRow}>
              <Text style={styles.exampleTag}>🍼 수유</Text>
              <Text style={styles.exampleText}>"분유 160", "맘마 140 먹었어", "모유 80ml"</Text>
            </View>
            <View style={styles.exampleRow}>
              <Text style={styles.exampleTag}>💧 소변</Text>
              <Text style={styles.exampleText}>"소변 봤어", "쉬했어", "기저귀 갈았어"</Text>
            </View>
            <View style={styles.exampleRow}>
              <Text style={styles.exampleTag}>💩 대변</Text>
              <Text style={styles.exampleText}>"대변 봤어", "응가했어", "똥 쌌어"</Text>
            </View>
            <View style={styles.exampleRow}>
              <Text style={styles.exampleTag}>😴 수면</Text>
              <Text style={styles.exampleText}>"지금 자", "낮잠 시작", "지금 깼어", "일어났어"</Text>
            </View>
            <View style={styles.exampleRow}>
              <Text style={styles.exampleTag}>🛁 목욕</Text>
              <Text style={styles.exampleText}>"목욕했어", "목욕 15분", "간단 씻기"</Text>
            </View>
            <View style={styles.exampleRow}>
              <Text style={styles.exampleTag}>⚖️ 체중</Text>
              <Text style={styles.exampleText}>"몸무게 5.8kg", "체중 6킬로"</Text>
            </View>
            <View style={styles.exampleRow}>
              <Text style={styles.exampleTag}>⏱️ 활동</Text>
              <Text style={styles.exampleText}>"터미타임 시작/끝", "놀기 시작/끝"</Text>
            </View>
          </View>
        ) : null}
      </View>

      <TouchableOpacity
        style={styles.autoSetting}
        onPress={() => void onAutoVoiceEnabledChange(!autoVoiceEnabled)}
        accessibilityRole="switch"
        accessibilityState={{ checked: autoVoiceEnabled }}
        accessibilityLabel="앱을 열 때 음성 입력 자동 시작"
      >
        <Text style={styles.autoSettingText}>앱을 열 때 바로 듣기</Text>
        <Text style={styles.autoSettingValue}>{autoVoiceEnabled ? '켜짐' : '꺼짐'}</Text>
      </TouchableOpacity>
      <Text style={styles.autoHelp}>Google이 아기기록을 열어 주거나 평소 앱을 열 때 작동해요. 말씀하신 내용은 바로 기록됩니다.</Text>
      <Text style={styles.privacy}>음성은 기기의 음성 인식 서비스에서 처리하며 파일은 저장되지 않습니다.</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { marginVertical: 12, padding: 14, backgroundColor: '#F3F6FF', borderRadius: 16 },
  button: { backgroundColor: '#4569A8', padding: 14, borderRadius: 12, alignItems: 'center' },
  buttonSaving: { backgroundColor: '#2B4C85' },
  buttonSaved: { backgroundColor: '#2E7D32' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  voiceStatus: { marginTop: 10, color: '#243F72', fontSize: 13, fontWeight: '600' },
  transcript: { marginTop: 10, color: '#334155', fontWeight: '500', fontSize: 14 },
  savedBanner: {
    marginTop: 12,
    backgroundColor: '#E8F5E9',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#C8E6C9',
  },
  savedTitle: { color: '#1B5E20', fontWeight: '700', fontSize: 14, marginBottom: 4 },
  savedDesc: { color: '#2E7D32', fontSize: 13, fontWeight: '600' },
  guideContainer: { marginTop: 12, backgroundColor: '#FFFFFF', borderRadius: 12, padding: 10, borderWidth: 1, borderColor: '#D9E2EC' },
  guideHeader: { paddingVertical: 4 },
  guideTitle: { color: '#334E68', fontSize: 13, fontWeight: '700' },
  examplesList: { marginTop: 8, gap: 6 },
  exampleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  exampleTag: { width: 68, fontSize: 12, fontWeight: '700', color: '#486581' },
  exampleText: { flex: 1, fontSize: 12, color: '#627D98' },
  autoSetting: { marginTop: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  autoSettingText: { color: '#17243D', fontSize: 14, fontWeight: '600' },
  autoSettingValue: { color: '#4569A8', fontSize: 14, fontWeight: '700' },
  autoHelp: { color: '#64748B', fontSize: 12 },
  privacy: { marginTop: 8, color: '#64748B', fontSize: 12 },
});
