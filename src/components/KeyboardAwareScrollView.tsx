import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardEvent,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  ScrollViewProps,
  StyleProp,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';

// 입력창 아래에 남겨 둘 여유 공간입니다.
const FOCUS_MARGIN = 24;

interface KeyboardAwareScrollViewProps extends ScrollViewProps {
  containerStyle?: StyleProp<ViewStyle>;
}

/**
 * 키보드가 덮는 높이만큼 아래 여백을 주고, 초점을 받은 입력창이 키보드 위에 보이도록 스크롤합니다.
 *
 * Android는 edge-to-edge가 켜져 있으면 adjustResize가 창을 줄이지 않으므로,
 * 키보드 위치와 이 화면의 위치를 창 기준 좌표로 직접 비교합니다.
 */
export const KeyboardAwareScrollView: React.FC<KeyboardAwareScrollViewProps> = ({
  containerStyle,
  children,
  onScroll,
  scrollEventThrottle,
  ...scrollProps
}) => {
  const containerRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollYRef = useRef(0);
  const keyboardTopRef = useRef<number | null>(null);
  const [keyboardInset, setKeyboardInset] = useState(0);

  // 화면 위치나 크기가 바뀔 때마다 다시 불러, 가려진 높이와 스크롤 위치를 맞춥니다.
  const adjustForKeyboard = useCallback(() => {
    const keyboardTop = keyboardTopRef.current;
    const container = containerRef.current;
    if (keyboardTop == null || !container) return;
    container.measureInWindow((_x, y, _width, height) => {
      const inset = Math.max(0, y + height - keyboardTop);
      setKeyboardInset(current => (Math.abs(current - inset) < 1 ? current : inset));
      const input = TextInput.State.currentlyFocusedInput();
      if (!input) return;
      input.measureInWindow((_ix, inputY, _iw, inputHeight) => {
        const visibleBottom = Math.min(y + height, keyboardTop) - FOCUS_MARGIN;
        const overflow = inputY + inputHeight - visibleBottom;
        if (overflow > 0) {
          scrollRef.current?.scrollTo({ y: scrollYRef.current + overflow, animated: true });
        }
      });
    });
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
      keyboardTopRef.current = event.endCoordinates.screenY;
      adjustForKeyboard();
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      keyboardTopRef.current = null;
      setKeyboardInset(0);
    });
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [adjustForKeyboard]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
    onScroll?.(event);
  };

  const handleLayout = (_event: LayoutChangeEvent) => {
    // 여백을 반영한 뒤나 바깥 모달이 줄어든 뒤에도 입력창이 보이는지 다시 확인합니다.
    if (keyboardTopRef.current != null) requestAnimationFrame(adjustForKeyboard);
  };

  return (
    <View ref={containerRef} style={[{ flex: 1 }, containerStyle, { paddingBottom: keyboardInset }]} onLayout={handleLayout}>
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        {...scrollProps}
        onScroll={handleScroll}
        scrollEventThrottle={scrollEventThrottle ?? 16}
        onLayout={handleLayout}
      >
        {children}
      </ScrollView>
    </View>
  );
};
