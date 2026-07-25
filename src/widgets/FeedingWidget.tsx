import { Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, padding } from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

export type FeedingWidgetProps = {
  babyName: string;
  lastFeedingLabel: string;
  nextFeedingLabel: string;
  remainingLabel: string;
  isOverdue: boolean;
};

const FeedingWidget = (props: FeedingWidgetProps, environment: WidgetEnvironment) => {
  'widget';
  const compact = environment.widgetFamily === 'accessoryInline';
  if (compact) {
    return <Text>🍼 {props.nextFeedingLabel} · {props.remainingLabel}</Text>;
  }
  return (
    <VStack modifiers={[padding({ all: 12 })]}>
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle('#8A6F68')]}>
        🍼 {props.babyName} 다음 수유
      </Text>
      <Text modifiers={[font({ size: 24, weight: 'bold' }), foregroundStyle(props.isOverdue ? '#D95D5D' : '#4A3F3B')]}>
        {props.nextFeedingLabel}
      </Text>
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(props.isOverdue ? '#D95D5D' : '#7A9B76')]}>
        {props.remainingLabel}
      </Text>
      <Text modifiers={[font({ size: 11 }), foregroundStyle('#9A8F8B')]}>
        마지막 수유 {props.lastFeedingLabel}
      </Text>
    </VStack>
  );
};

export default createWidget<FeedingWidgetProps>('FeedingReminderWidget', FeedingWidget);
