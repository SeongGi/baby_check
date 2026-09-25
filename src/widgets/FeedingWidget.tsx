import { HStack, Link, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  background,
  containerBackground,
  cornerRadius,
  font,
  foregroundStyle,
  frame,
  padding,
  widgetURL,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

export type FeedingWidgetProps = {
  babyName: string;
  lastFeedingLabel: string;
  nextFeedingLabel: string;
  remainingLabel: string;
  isOverdue: boolean;
  statusLabel: string;
  formulaLabel: string;
  urineLabel: string;
  stoolLabel: string;
  sleepLabel: string;
};

const FeedingWidget = (props: FeedingWidgetProps, environment: WidgetEnvironment) => {
  'widget';
  const compact = environment.widgetFamily === 'accessoryInline';
  const rectangular = environment.widgetFamily === 'accessoryRectangular';
  const small = environment.widgetFamily === 'systemSmall';
  const large = environment.widgetFamily === 'systemLarge';
  const backgroundColor = environment.colorScheme === 'dark' ? '#2B2523' : '#FFF9F6';
  const primaryText = environment.colorScheme === 'dark' ? '#FFF7F3' : '#4A3F3B';
  const mutedText = environment.colorScheme === 'dark' ? '#D7C9C2' : '#8A7770';
  const accent = props.isOverdue ? '#E46B6B' : '#6F9270';
  if (compact) {
    return <Text>🍼 {props.nextFeedingLabel} · {props.remainingLabel}</Text>;
  }
  if (rectangular) {
    return (
      <VStack
        spacing={1}
        modifiers={[widgetURL('babycheck://dashboard'), containerBackground(backgroundColor, 'widget')]}
      >
        <Text modifiers={[font({ size: 13, weight: 'bold' }), foregroundStyle(primaryText)]}>
          {props.babyName} · {props.statusLabel}
        </Text>
        <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(accent)]}>
          🍼 {props.remainingLabel} ({props.nextFeedingLabel})
        </Text>
      </VStack>
    );
  }

  const summary = (
    <VStack alignment="leading" spacing={small ? 5 : 7}>
      <Text modifiers={[font({ size: 13, weight: 'bold' }), foregroundStyle(mutedText)]}>
        {props.babyName} · {props.statusLabel}
      </Text>
      <Text modifiers={[font({ size: small ? 24 : 28, weight: 'bold' }), foregroundStyle(primaryText)]}>
        {props.nextFeedingLabel}
      </Text>
      <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(accent)]}>
        {props.remainingLabel}
      </Text>
      <Text modifiers={[font({ size: 11 }), foregroundStyle(mutedText)]}>
        마지막 수유 {props.lastFeedingLabel}
      </Text>
    </VStack>
  );

  if (small) {
    return (
      <VStack modifiers={[
        padding({ all: 12 }),
        widgetURL('babycheck://formula'),
        containerBackground(backgroundColor, 'widget'),
      ]}>
        {summary}
      </VStack>
    );
  }

  return (
    <VStack
      spacing={10}
      modifiers={[padding({ all: 12 }), containerBackground(backgroundColor, 'widget')]}
    >
      <HStack spacing={14} alignment="top">
        {summary}
        <Spacer />
        <VStack alignment="leading" spacing={6}>
          <Link destination="babycheck://formula" modifiers={[foregroundStyle(primaryText)]}>
            <Text modifiers={[font({ size: 12, weight: 'semibold' })]}>🍼 {props.formulaLabel}</Text>
          </Link>
          <Link destination="babycheck://diaper" modifiers={[foregroundStyle(primaryText)]}>
            <Text modifiers={[font({ size: 12, weight: 'semibold' })]}>💧 {props.urineLabel}</Text>
          </Link>
          <Link destination="babycheck://diaper" modifiers={[foregroundStyle(primaryText)]}>
            <Text modifiers={[font({ size: 12, weight: 'semibold' })]}>💩 {props.stoolLabel}</Text>
          </Link>
          <Link destination="babycheck://dashboard" modifiers={[foregroundStyle(primaryText)]}>
            <Text modifiers={[font({ size: 12, weight: 'semibold' })]}>😴 {props.sleepLabel}</Text>
          </Link>
        </VStack>
      </HStack>
      {large ? (
        <HStack spacing={8}>
          <Link label="수유 기록" destination="babycheck://formula" modifiers={[
            font({ size: 12, weight: 'bold' }),
            foregroundStyle('#FFFFFF'),
            padding({ horizontal: 12, vertical: 7 }),
            background('#F08CA0'),
            cornerRadius(10),
            frame({ maxWidth: Infinity }),
          ]} />
          <Link label="기저귀 기록" destination="babycheck://diaper" modifiers={[
            font({ size: 12, weight: 'bold' }),
            foregroundStyle('#FFFFFF'),
            padding({ horizontal: 12, vertical: 7 }),
            background('#77A7C7'),
            cornerRadius(10),
            frame({ maxWidth: Infinity }),
          ]} />
        </HStack>
      ) : null}
    </VStack>
  );
};

export default createWidget<FeedingWidgetProps>('FeedingReminderWidget', FeedingWidget);
