// ─── ZAIM Design System ───
// Dark neon arcade aesthetic with orange/teal accents

export const colors = {
  // Backgrounds
  bg: '#0d0f10',
  card: '#161819',
  cardBorder: 'rgba(255,255,255,0.06)',
  surface: '#1c1e20',
  divider: 'rgba(255,255,255,0.06)',

  // Text
  text: '#f0f0f0',
  textDim: 'rgba(255,255,255,0.4)',
  textMuted: 'rgba(255,255,255,0.55)',

  // Orange (primary action)
  orange: '#ff6b2c',
  orangeGlow: 'rgba(255,107,44,0.25)',
  orangeSurface: 'rgba(255,107,44,0.08)',
  orangeBorder: 'rgba(255,107,44,0.2)',

  // Teal (secondary / ZEC)
  teal: '#00d68f',
  tealGlow: 'rgba(0,214,143,0.25)',
  tealSurface: 'rgba(0,214,143,0.08)',
  tealBorder: 'rgba(0,214,143,0.2)',

  // Status
  success: '#00d68f',
  warning: '#ffb020',
  error: '#ff4757',
  pending: '#ffa502',

  // Blue (AI / info)
  blue: '#3b5bff',
  blueSurface: 'rgba(59,91,255,0.08)',
};

export const fonts = {
  display: "'JetBrains Mono', 'SF Mono', monospace",
  body: "'Inter', -apple-system, sans-serif",
  mono: "'JetBrains Mono', 'SF Mono', monospace",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
};

export const radii = {
  sm: 8,
  md: 14,
  lg: 20,
  full: 9999,
};

// Shared styles
export const glassCard = {
  background: colors.card,
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: radii.lg,
  backdropFilter: 'blur(20px)',
};
