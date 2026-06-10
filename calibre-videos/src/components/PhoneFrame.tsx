import React from 'react';
import { COLORS } from '../brand/theme';
import { FONT_FAMILY } from '../brand/fonts';

/**
 * A phone-screen mock used for UGC-style "filmed on my phone" reviews and for
 * showing the website / eBay listing on-screen. Children render inside the screen.
 */
export const PhoneFrame: React.FC<{
  children?: React.ReactNode;
  width?: number;
  topLabel?: string;
}> = ({ children, width = 620, topLabel }) => {
  const height = width * 2.05;
  return (
    <div
      style={{
        width,
        height,
        background: '#0A0E16',
        borderRadius: width * 0.13,
        padding: width * 0.03,
        boxShadow: '0 40px 90px rgba(0,0,0,0.55)',
        border: `${width * 0.012}px solid #2A3144`,
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: width * 0.05,
          left: '50%',
          transform: 'translateX(-50%)',
          width: width * 0.34,
          height: width * 0.05,
          background: '#000',
          borderRadius: 100,
          zIndex: 5,
        }}
      />
      <div
        style={{
          width: '100%',
          height: '100%',
          borderRadius: width * 0.1,
          overflow: 'hidden',
          position: 'relative',
          background: COLORS.navyInk,
        }}
      >
        {topLabel && (
          <div
            style={{
              position: 'absolute',
              top: width * 0.085,
              width: '100%',
              textAlign: 'center',
              color: COLORS.white,
              fontFamily: FONT_FAMILY.body,
              fontWeight: 700,
              fontSize: width * 0.045,
              zIndex: 4,
              opacity: 0.85,
            }}
          >
            {topLabel}
          </div>
        )}
        {children}
      </div>
    </div>
  );
};
