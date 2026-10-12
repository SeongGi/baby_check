export type VoicePhase = 'idle' | 'starting' | 'listening' | 'processing' | 'saving' | 'saved' | 'ready' | 'error';

export const getVoiceStatusText = (phase: VoicePhase, errorMessage: string | null): string => {
  switch (phase) {
    case 'starting': return '마이크를 준비하고 있어요.';
    case 'listening': return '듣고 있어요. 기록할 내용을 말씀해 주세요.';
    case 'processing': return '말씀하신 명령을 처리 중이에요.';
    case 'saving': return '기록을 저장하고 있어요…';
    case 'saved': return '기록 저장이 완료되었어요!';
    case 'ready': return '명령을 확인했어요. 아래 내용을 확인한 뒤 저장해 주세요.';
    case 'error': return errorMessage || '음성 입력을 시작하지 못했어요. 다시 눌러 주세요.';
    default: return '버튼을 누르고 기록할 내용을 말씀해 주세요.';
  }
};
