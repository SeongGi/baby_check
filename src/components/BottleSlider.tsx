import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, PanResponder, ViewStyle, Dimensions } from 'react-native';
import { COLORS } from '../theme/colors';

interface BottleSliderProps {
  value: number; // in ml (0 to 300)
  onChange: (value: number) => void;
}

const BOTTLE_HEIGHT = 320; // height of the draggable bottle body in dp
const MAX_ML = 300;

export const BottleSlider: React.FC<BottleSliderProps> = ({ value, onChange }) => {
  const [isDragging, setIsDragging] = useState(false);
  const bottleRef = useRef<View>(null);

  // Calculate the y position of the current ml value
  // 0 ml is at the bottom (y = BOTTLE_HEIGHT)
  // 300 ml is at the top (y = 0)
  const getFillHeight = () => {
    return (value / MAX_ML) * BOTTLE_HEIGHT;
  };

  const handleTouch = (y: number) => {
    // y is relative to the top of the bottle container
    // Clamp y between 0 and BOTTLE_HEIGHT
    const clampedY = Math.max(0, Math.min(BOTTLE_HEIGHT, y));
    
    // Invert because 0 ml is at the bottom
    const calculatedMl = ((BOTTLE_HEIGHT - clampedY) / BOTTLE_HEIGHT) * MAX_ML;
    
    // Round to nearest 10ml
    const roundedMl = Math.round(calculatedMl / 10) * 10;
    
    // Clamp between 0 and 300
    const finalMl = Math.max(0, Math.min(MAX_ML, roundedMl));
    onChange(finalMl);
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (evt, gestureState) => {
        setIsDragging(true);
        // Get the touch location relative to the node
        const y = evt.nativeEvent.locationY;
        handleTouch(y);
      },
      onPanResponderMove: (evt, gestureState) => {
        // In move event, locationY is not always relative to the element (can jump if dragging outside)
        // Better: use gestureState.dy or absolute position if available
        // Let's use the touch Y coordinate. We can estimate it relative to the bottle element
        // Since we are dragging, we can check the locationY. On React Native, locationY on move is relative to the element.
        const y = evt.nativeEvent.locationY;
        handleTouch(y);
      },
      onPanResponderRelease: () => {
        setIsDragging(false);
      },
      onPanResponderTerminate: () => {
        setIsDragging(false);
      },
    })
  ).current;

  // Render graduation marks (50, 100, 150, 200, 250, 300 ml)
  const graduations = [300, 250, 200, 150, 100, 50];

  return (
    <View style={styles.container}>
      {/* Current Volume Display Card */}
      <View style={styles.volumeCard}>
        <Text style={styles.volumeLabel}>수유량</Text>
        <View style={styles.volumeNumberContainer}>
          <Text style={styles.volumeNumber}>{value}</Text>
          <Text style={styles.volumeUnit}>ml</Text>
        </View>
        <Text style={styles.helperText}>젖병을 위아래로 드래그하여 조절하세요</Text>
      </View>

      {/* Beautiful Baby Bottle Layout */}
      <View style={styles.bottleContainer}>
        {/* Nipple / Teat */}
        <View style={styles.nipple} />
        
        {/* Collar / Cap Ring */}
        <View style={styles.collar} />

        {/* Bottle Body */}
        <View 
          ref={bottleRef}
          style={styles.bottleBody}
          {...panResponder.panHandlers}
        >
          {/* Milk Liquid Fill */}
          <View style={[styles.milkFill, { height: getFillHeight() }]}>
            {/* Liquid wave highlight overlay */}
            <View style={styles.milkWaveTop} />
            <View style={styles.milkGlassHighlight} />
          </View>

          {/* Glass Glossy Highlight (vertical stripe) */}
          <View style={styles.glassHighlightStripe} />

          {/* Graduation lines */}
          <View style={styles.graduationsContainer} pointerEvents="none">
            {graduations.map((grad) => {
              const gradY = BOTTLE_HEIGHT - (grad / MAX_ML) * BOTTLE_HEIGHT;
              const isFilled = value >= grad;
              return (
                <View 
                  key={grad} 
                  style={[
                    styles.gradLineRow, 
                    { top: gradY - 8 } // Center vertically
                  ]}
                >
                  <View style={[styles.gradTick, isFilled && styles.gradTickFilled]} />
                  <Text style={[styles.gradText, isFilled && styles.gradTextFilled]}>
                    {grad}
                  </Text>
                </View>
              );
            })}
          </View>
          
          {/* Animated floating bubble/indicator during drag */}
          {isDragging && (
            <View style={[styles.floatingBubble, { bottom: getFillHeight() - 20 }]}>
              <Text style={styles.floatingBubbleText}>{value} ml</Text>
            </View>
          )}
        </View>
        
        {/* Bottle Bottom Base */}
        <View style={styles.bottleBase} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    width: '100%',
  },
  volumeCard: {
    backgroundColor: COLORS.card,
    borderRadius: 20,
    paddingVertical: 15,
    paddingHorizontal: 25,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 3,
    marginBottom: 25,
    borderWidth: 1,
    borderColor: COLORS.border,
    width: '80%',
  },
  volumeLabel: {
    fontSize: 14,
    color: COLORS.textMuted,
    fontWeight: '600',
    marginBottom: 4,
  },
  volumeNumberContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  volumeNumber: {
    fontSize: 42,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  volumeUnit: {
    fontSize: 20,
    fontWeight: '600',
    color: COLORS.primary,
    marginLeft: 4,
  },
  helperText: {
    fontSize: 12,
    color: COLORS.textMuted,
    marginTop: 6,
    textAlign: 'center',
  },
  bottleContainer: {
    alignItems: 'center',
    width: 200,
    position: 'relative',
  },
  nipple: {
    width: 40,
    height: 35,
    backgroundColor: '#FFE6C7', // soft yellow/flesh color for teat
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 5,
    opacity: 0.9,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 1,
  },
  collar: {
    width: 100,
    height: 25,
    backgroundColor: COLORS.primary, // Cap collar matches primary theme pink
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    zIndex: 2,
  },
  bottleBody: {
    width: 130,
    height: BOTTLE_HEIGHT,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    borderColor: '#EAEAEA',
    borderWidth: 4,
    borderBottomLeftRadius: 25,
    borderBottomRightRadius: 25,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    position: 'relative',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 4,
  },
  milkFill: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FFFDF0', // Creamy warm milk color
  },
  milkWaveTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 6,
    backgroundColor: '#FAF5D8', // Highlight top of milk
  },
  milkGlassHighlight: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 10,
    width: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.3)', // milk highlight
  },
  glassHighlightStripe: {
    position: 'absolute',
    top: 10,
    bottom: 10,
    right: 15,
    width: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.4)', // glass gloss reflection
    pointerEvents: 'none',
  },
  graduationsContainer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  gradLineRow: {
    position: 'absolute',
    left: 15,
    flexDirection: 'row',
    alignItems: 'center',
    width: 60,
  },
  gradTick: {
    width: 15,
    height: 2.5,
    backgroundColor: '#D1CFC7',
    borderRadius: 1,
  },
  gradTickFilled: {
    backgroundColor: '#A67C52', // Darker when submerged in milk
  },
  gradText: {
    fontSize: 10,
    color: '#9E9C94',
    fontWeight: 'bold',
    marginLeft: 6,
  },
  gradTextFilled: {
    color: '#8D5B4C', // Poop-like brown or darker brown text when submerged
  },
  floatingBubble: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: '#2B2B2B',
    borderRadius: 15,
    paddingVertical: 5,
    paddingHorizontal: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
    zIndex: 10,
  },
  floatingBubbleText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
  bottleBase: {
    width: 110,
    height: 6,
    backgroundColor: '#EAEAEA',
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    marginTop: -2,
  },
});
