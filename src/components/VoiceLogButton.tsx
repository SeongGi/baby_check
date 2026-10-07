import React, { useEffect, useRef, useState } from 'react';
import { Alert, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { BabyLogEntry, SleepLog } from '../types';
import { parseVoiceCommand, VoiceCommand } from '../utils/voiceCommand';

type Props = {
  logs: BabyLogEntry[];
  onAddLog: (log: Omit<BabyLogEntry, 'id'>) => Promise<unknown>;
  onUpdateLog: (log: BabyLogEntry) => Promise<boolean>;
  autoVoiceEnabled: boolean;
  onAutoVoiceEnabledChange: (enabled: boolean) => Promise<void>;
  autoStartRequest: number;
  onAutoStartHandled: (request: number) => void;
};

export const VoiceLogButton: React.FC<Props> = ({ logs, onAddLog, onUpdateLog, autoVoiceEnabled, onAutoVoiceEnabledChange, autoStartRequest, onAutoStartHandled }) => {
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
  const startGeneration = useRef(0);
  const handledAutoRequestRef = useRef(0);

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
      interrupted.current = true;
      startGeneration.current += 1;
      if (starting.current || listeningRef.current) ExpoSpeechRecognitionModule.abort();
      starting.current = false;
      setAttemptRevision(revision => revision + 1);
    });
    return () => {
      mounted.current = false;
      interrupted.current = true;
      startGeneration.current += 1;
      subscription.remove();
      if (starting.current || listeningRef.current) ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  useSpeechRecognitionEvent('start', () => {
    if (interrupted.current || AppState.currentState !== 'active') {
      ExpoSpeechRecognitionModule.abort();
      return;
    }
    listeningRef.current = true;
    setListening(true);
    setStatusMessage(null);
  });
  useSpeechRecognitionEvent('end', () => { listeningRef.current = false; setListening(false); starting.current = false; setAttemptRevision(revision => revision + 1); });
  useSpeechRecognitionEvent('result', event => {
    if (!event.isFinal || interrupted.current) return;
    const recognized = event.results[0]?.transcript?.trim() || '';
    setTranscript(recognized);
    setCommand(parseVoiceCommand(recognized));
    setSpokenAt(Date.now());
  });
  useSpeechRecognitionEvent('error', event => {
    setListening(false);
    starting.current = false;
    setAttemptRevision(revision => revision + 1);
    if (event.error !== 'aborted') {
      const message = `음성 인식 오류 (${event.error}): ${event.message || '기기의 음성 인식 서비스를 확인해 주세요.'}`;
      setStatusMessage(message);
      Alert.alert('음성 인식 실패', message);
    }
  });

  const start = async (): Promise<'handled' | 'deferred'> => {
    if (starting.current || listeningRef.current || AppState.currentState !== 'active') return 'deferred';
    starting.current = true;
    interrupted.current = false;
    const generation = ++startGeneration.current;
    setTranscript('');
    setCommand(null);
    setSpokenAt(null);
    setStatusMessage(null);
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        const message = '기기의 음성 인식 서비스를 사용할 수 없습니다. Google 음성 인식 서비스가 설치·활성화되어 있는지 확인해 주세요.';
        setStatusMessage(message);
        Alert.alert('음성 인식 서비스 없음', message);
        starting.current = false;
        return 'handled';
      }
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!mounted.current || interrupted.current || generation !== startGeneration.current || AppState.currentState !== 'active') {
        if (generation === startGeneration.current) starting.current = false;
        return 'deferred';
      }
      if (!permission.granted) {
        const message = '음성 기록을 사용하려면 앱 설정에서 마이크 권한을 허용해 주세요.';
        setStatusMessage(message);
        Alert.alert('마이크 권한 필요', message);
        starting.current = false;
        return 'handled';
      }
      ExpoSpeechRecognitionModule.start({ lang: 'ko-KR', interimResults: false, continuous: false });
      return 'handled';
    } catch {
      if (!mounted.current || interrupted.current || generation !== startGeneration.current || AppState.currentState !== 'active') {
        if (generation === startGeneration.current) starting.current = false;
        return 'deferred';
      }
      if (generation === startGeneration.current) {
        starting.current = false;
        if (mounted.current) {
          const message = '이 기기에서 음성 인식을 시작하지 못했습니다. 마이크 권한과 음성 인식 서비스를 확인해 주세요.';
          setStatusMessage(message);
          Alert.alert('음성 인식 불가', message);
        }
      }
      return 'handled';
    } finally {
      if (!starting.current && mounted.current) setAttemptRevision(revision => revision + 1);
    }
  };

  useEffect(() => {
    if (!autoStartRequest) return;
    if (handledAutoRequestRef.current === autoStartRequest) return;
    if (!autoVoiceEnabled || transcript || command) {
      completeAutoRequest(autoStartRequest);
      return;
    }
    if (!mounted.current || AppState.currentState !== 'active') return;
    if (listeningRef.current) {
      completeAutoRequest(autoStartRequest);
      return;
    }
    if (starting.current) return;
    void start().then(result => {
      if (result === 'handled' && mounted.current) completeAutoRequest(autoStartRequest);
    });
  }, [autoStartRequest, autoVoiceEnabled, foregroundRevision, attemptRevision]);

  const activeSleep = logs
    .filter((log): log is SleepLog => log.type === 'sleep' && log.endedAt == null)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  const description = command?.kind === 'formula'
    ? `분유 ${command.amount}ml 기록`
    : command?.kind === 'sleepStart' ? '지금 수면 시작'
    : command?.kind === 'sleepEnd' ? '지금 수면 종료'
    : null;

  const save = async () => {
    if (!command || command.kind === 'unknown' || spokenAt === null || busy) return;
    if (command.kind === 'sleepStart' && activeSleep) {
      Alert.alert('이미 자는 중', '진행 중인 수면을 먼저 종료해 주세요.');
      return;
    }
    if (command.kind === 'sleepEnd' && !activeSleep) {
      Alert.alert('진행 중인 수면 없음', '먼저 수면 시작을 기록해 주세요.');
      return;
    }
    setBusy(true);
    try {
      const result = command.kind === 'formula'
        ? await onAddLog({ type: 'formula', feedingType: 'formula', amount: command.amount, timestamp: spokenAt } as Omit<BabyLogEntry, 'id'>)
        : command.kind === 'sleepStart'
          ? await onAddLog({ type: 'sleep', timestamp: spokenAt })
          : await onUpdateLog({ ...activeSleep!, endedAt: Math.max(activeSleep!.timestamp, spokenAt) });
      if (result === null || result === false) throw new Error('save failed');
      setTranscript('');
      setCommand(null);
      setSpokenAt(null);
      Alert.alert('기록 완료', description || '저장되었습니다.');
    } catch {
      Alert.alert('저장 실패', '기록을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.button}
        onPress={listening ? () => ExpoSpeechRecognitionModule.stop() : () => {
          if (autoStartRequest) completeAutoRequest(autoStartRequest);
          void start();
        }}
        accessibilityLabel={listening ? '음성 입력 끝내기' : '음성으로 기록하기'}
      >
        <Text style={styles.buttonText}>{listening ? '듣는 중… 탭하여 끝내기' : '🎤 음성으로 기록하기'}</Text>
      </TouchableOpacity>
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
      {statusMessage ? <Text style={styles.help}>{statusMessage}</Text> : null}
      {transcript ? <Text style={styles.transcript}>인식: {transcript}</Text> : null}
      {command?.kind === 'unknown' ? <Text style={styles.help}>명령을 이해하지 못했어요. “분유 120ml 먹었어”, “지금 자”, “지금 깼어”처럼 말해 주세요.</Text> : null}
      {description ? (
        <View style={styles.confirm}>
          <Text style={styles.description}>{description}</Text>
          <TouchableOpacity onPress={save} disabled={busy} style={styles.save}><Text style={styles.saveText}>{busy ? '저장 중…' : '기록 확인'}</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => { setTranscript(''); setCommand(null); setSpokenAt(null); }}><Text style={styles.cancel}>취소</Text></TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { marginVertical: 12, padding: 14, backgroundColor: '#F3F6FF', borderRadius: 16 },
  button: { backgroundColor: '#4569A8', padding: 14, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  autoSetting: { marginTop: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8 },
  autoSettingText: { color: '#17243D', fontSize: 14, fontWeight: '600' },
  autoSettingValue: { color: '#4569A8', fontSize: 14, fontWeight: '700' },
  autoHelp: { color: '#64748B', fontSize: 12 },
  privacy: { marginTop: 8, color: '#64748B', fontSize: 12 },
  transcript: { marginTop: 12, color: '#334155' },
  help: { marginTop: 8, color: '#8A4317' },
  confirm: { marginTop: 12, gap: 10 },
  description: { fontSize: 16, fontWeight: '700', color: '#17243D' },
  save: { backgroundColor: '#243F72', borderRadius: 10, padding: 11, alignItems: 'center' },
  saveText: { color: '#fff', fontWeight: '700' },
  cancel: { color: '#4569A8', textAlign: 'center', padding: 4 },
});
