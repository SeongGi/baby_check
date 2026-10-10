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
  const [spokenAt, setSpokenAt] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
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
      if (nativeSessionOpenRef.current) ExpoSpeechRecognitionModule.abort();
    };
  }, []);

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
    setTranscript(recognized);
    setCommand(parsed);
    setSpokenAt(Date.now());
    setPhase('processing');
    setStatusMessage('명령을 처리 중이에요…');
    const generation = startGeneration.current;
    processingTimerRef.current = setTimeout(() => {
      processingTimerRef.current = null;
      if (!mounted.current || generation !== startGeneration.current) return;
      setPhase(parsed.kind === 'unknown' ? 'error' : 'ready');
      setStatusMessage(parsed.kind === 'unknown' ? '명령을 이해하지 못했어요. 아래 예시처럼 다시 말해 주세요.' : null);
    }, 300);
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
    terminalEventRef.current = 'none';
    resumeAfterPermissionRef.current = false;
    setPhase('starting');
    setTranscript('');
    setCommand(null);
    setSpokenAt(null);
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
    if (nativeSessionOpenRef.current) {
      completeAutoRequest(autoStartRequest);
      return;
    }
    if (starting.current) {
      completeAutoRequest(autoStartRequest);
      return;
    }
    // Consume the automatic request before opening the system recognizer. Its UI can
    // briefly change AppState, but that must never retry the same request.
    completeAutoRequest(autoStartRequest);
    void start();
  }, [autoStartRequest, autoVoiceEnabled, foregroundRevision, attemptRevision, busy]);

  const description = command?.kind === 'formula'
    ? `${command.feedingType === 'breast' ? '모유' : command.feedingType === 'mixed' ? '혼합 수유' : '분유'} ${command.amount}ml 기록`
    : command?.kind === 'urine' ? `소변 기록 · 젖은 정도 ${command.wetness ? { light: '적음', medium: '보통', heavy: '많음' }[command.wetness] : '미입력'} · 색 ${command.color ? { clear: '맑음', normal: '보통', dark: '진함' }[command.color] : '미입력'}`
    : command?.kind === 'stool' ? `대변 기록 · 색 ${command.color ? { yellow: '노란색', green: '녹색', brown: '갈색', red: '빨간색', black: '검은색', grey: '회색' }[command.color] : '미입력'} · 형태 ${command.consistency ? { soft: '보통', watery: '묽음', hard: '단단함' }[command.consistency] : '미입력'} · 양 ${command.amount ? { small: '적음', medium: '보통', large: '많음' }[command.amount] : '미입력'}`
    : command?.kind === 'bath' ? `${command.bathType === 'quick' ? '간단 씻기' : '목욕'} ${command.durationMinutes === undefined ? '시간 미입력' : `${command.durationMinutes}분`} 기록`
    : command?.kind === 'weight' ? `몸무게 ${command.weightKg}kg 기록`
    : command?.kind === 'sleepStart' ? '지금 수면 시작'
    : command?.kind === 'sleepEnd' ? '지금 수면 종료'
    : command?.kind === 'tummyStart' ? '터미타임 시작'
    : command?.kind === 'tummyEnd' ? '터미타임 종료'
    : command?.kind === 'playStart' ? '놀기시간 시작'
    : command?.kind === 'playEnd' ? '놀기시간 종료'
    : null;

  const editCommand = (patch: Partial<VoiceCommand>) => setCommand(current => current && current.kind !== 'unknown' ? { ...current, ...patch } as VoiceCommand : current);

  const voiceStatusText = getVoiceStatusText(phase, statusMessage);

  useEffect(() => {
    if (Platform.OS === 'ios' && phase !== 'idle') AccessibilityInfo.announceForAccessibility(voiceStatusText);
  }, [phase, voiceStatusText]);

  const save = async () => {
    if (!command || command.kind === 'unknown' || spokenAt === null || savePendingRef.current) return;
    if ((command.kind === 'urine' && (!command.wetness || !command.color)) ||
        (command.kind === 'stool' && (!command.color || !command.consistency || !command.amount)) ||
        (command.kind === 'bath' && command.durationMinutes === undefined)) {
      Alert.alert('정보 입력 필요', '미입력 항목을 선택한 뒤 기록해 주세요.');
      return;
    }
    const timedType = command.kind.startsWith('sleep') ? 'sleep' : command.kind.startsWith('tummy') ? 'tummyTime' : command.kind.startsWith('play') ? 'play' : null;
    const ending = command.kind.endsWith('End');
    const active = timedType ? logsRef.current.filter(log => log.type === timedType && log.endedAt == null).sort((a, b) => b.timestamp - a.timestamp)[0] : undefined;
    if (timedType && ((ending && (!active || active.timestamp > spokenAt)) || (!ending && active))) {
      Alert.alert('상태 확인', ending ? '종료할 진행 중 기록이 없습니다. 새로고침 후 다시 시도해 주세요.' : '이미 진행 중인 기록이 있습니다.');
      return;
    }
    savePendingRef.current = true;
    setBusy(true);
    try {
      const result = command.kind === 'formula'
        ? await onAddLog({ type: 'formula', feedingType: command.feedingType ?? 'formula', amount: command.amount, formulaAmount: command.formulaAmount, breastAmount: command.breastAmount, temperature: command.temperature, timestamp: spokenAt } as Omit<BabyLogEntry, 'id'>)
        : command.kind === 'urine' ? await onAddLog({ type: 'urine', wetness: command.wetness, color: command.color, timestamp: spokenAt } as Omit<BabyLogEntry, 'id'>)
        : command.kind === 'stool' ? await onAddLog({ type: 'stool', color: command.color, consistency: command.consistency, amount: command.amount, timestamp: spokenAt } as Omit<BabyLogEntry, 'id'>)
        : command.kind === 'bath' ? await onAddLog({ type: 'bath', bathType: command.bathType, durationMinutes: command.durationMinutes, timestamp: spokenAt } as Omit<BabyLogEntry, 'id'>)
        : command.kind === 'weight' ? await onAddLog({ type: 'weight', weightKg: command.weightKg, timestamp: spokenAt } as Omit<BabyLogEntry, 'id'>)
        : ending ? await onUpdateLog({ ...active!, endedAt: spokenAt } as BabyLogEntry)
        : await onAddLog({ type: timedType!, timestamp: spokenAt } as Omit<BabyLogEntry, 'id'>);
      if (result === null || result === false) throw new Error('save failed');
      setTranscript('');
      setCommand(null);
      setSpokenAt(null);
      setPhase('idle');
      setStatusMessage(null);
      Alert.alert('기록 완료', description || '저장되었습니다.');
    } catch {
      Alert.alert('저장 실패', '기록을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      savePendingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.button}
        disabled={busy || phase === 'starting' || phase === 'processing'}
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
        <Text style={styles.buttonText}>{phase === 'starting' ? '마이크 준비 중…' : listening ? '듣고 있어요… 탭하여 끝내기' : phase === 'processing' ? '명령 처리 중…' : '🎤 음성으로 기록하기'}</Text>
      </TouchableOpacity>
      <Text accessibilityLiveRegion="polite" style={styles.voiceStatus}>{voiceStatusText}</Text>
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
      <Text style={styles.autoHelp}>Google이 아기기록을 열어 주거나 평소 앱을 열 때 작동해요. 기록은 확인 후 저장됩니다.</Text>
      <Text style={styles.privacy}>음성은 기기의 음성 인식 서비스에서 처리합니다. 앱은 녹음 파일을 저장하지 않습니다.</Text>
      {transcript ? <Text style={styles.transcript}>인식: {transcript}</Text> : null}
      {command?.kind === 'unknown' ? <Text style={styles.help}>명령을 이해하지 못했어요. “분유 120ml 먹었어”, “소변 봤어”, “대변 봤어”, “목욕 10분”, “몸무게 5.2kg”, “터미타임 시작”처럼 말해 주세요.</Text> : null}
      {phase === 'ready' && description ? (
        <View style={styles.confirm}>
          <Text style={styles.description}>{description}</Text>
          {command?.kind === 'bath' ? <View style={styles.editRow}>{[5, 10, 15, 20].map(minutes => <TouchableOpacity key={minutes} style={styles.editButton} onPress={() => editCommand({ durationMinutes: minutes } as Partial<VoiceCommand>)}><Text>{minutes}분</Text></TouchableOpacity>)}</View> : null}
          {command?.kind === 'urine' ? <View style={styles.editRow}>
            <TouchableOpacity style={styles.editButton} onPress={() => editCommand({ wetness: !command.wetness ? 'medium' : command.wetness === 'light' ? 'medium' : command.wetness === 'medium' ? 'heavy' : 'light' } as Partial<VoiceCommand>)}><Text>젖은 정도 선택</Text></TouchableOpacity>
            <TouchableOpacity style={styles.editButton} onPress={() => editCommand({ color: !command.color ? 'normal' : command.color === 'clear' ? 'normal' : command.color === 'normal' ? 'dark' : 'clear' } as Partial<VoiceCommand>)}><Text>색 선택</Text></TouchableOpacity>
          </View> : null}
          {command?.kind === 'stool' ? <View style={styles.editRow}>
            <TouchableOpacity style={styles.editButton} onPress={() => editCommand({ color: command.color ? ({ yellow: 'green', green: 'brown', brown: 'red', red: 'black', black: 'grey', grey: 'yellow' } as const)[command.color] : 'yellow' } as Partial<VoiceCommand>)}><Text>색 선택</Text></TouchableOpacity>
            <TouchableOpacity style={styles.editButton} onPress={() => editCommand({ consistency: !command.consistency ? 'soft' : command.consistency === 'soft' ? 'watery' : command.consistency === 'watery' ? 'hard' : 'soft' } as Partial<VoiceCommand>)}><Text>형태 선택</Text></TouchableOpacity>
            <TouchableOpacity style={styles.editButton} onPress={() => editCommand({ amount: !command.amount ? 'medium' : command.amount === 'small' ? 'medium' : command.amount === 'medium' ? 'large' : 'small' } as Partial<VoiceCommand>)}><Text>양 선택</Text></TouchableOpacity>
          </View> : null}
          <TouchableOpacity onPress={save} disabled={busy} style={styles.save}><Text style={styles.saveText}>{busy ? '저장 중…' : '기록 확인'}</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => { setTranscript(''); setCommand(null); setSpokenAt(null); setPhase('idle'); setStatusMessage(null); }}><Text style={styles.cancel}>취소</Text></TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { marginVertical: 12, padding: 14, backgroundColor: '#F3F6FF', borderRadius: 16 },
  button: { backgroundColor: '#4569A8', padding: 14, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  voiceStatus: { marginTop: 10, color: '#243F72', fontSize: 13, fontWeight: '600' },
  autoSetting: { marginTop: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  autoSettingText: { color: '#17243D', fontSize: 14, fontWeight: '600' },
  autoSettingValue: { color: '#4569A8', fontSize: 14, fontWeight: '700' },
  autoHelp: { color: '#64748B', fontSize: 12 },
  privacy: { marginTop: 8, color: '#64748B', fontSize: 12 },
  transcript: { marginTop: 12, color: '#334155' },
  help: { marginTop: 8, color: '#8A4317' },
  confirm: { marginTop: 12, gap: 10 },
  editRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  editButton: { padding: 9, backgroundColor: '#E0EAFB', borderRadius: 8 },
  description: { fontSize: 16, fontWeight: '700', color: '#17243D' },
  save: { backgroundColor: '#243F72', borderRadius: 10, padding: 11, alignItems: 'center' },
  saveText: { color: '#fff', fontWeight: '700' },
  cancel: { color: '#4569A8', textAlign: 'center', padding: 4 },
});
