import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        void: {
          DEFAULT: '#070405',
          950: '#040203',
          900: '#070405',
          850: '#100A0D',
          800: '#180E12',
          700: '#25161A',
        },
        edge: {
          DEFAULT: '#2B1518',
          hi: '#472226',
        },
        live: {
          DEFAULT: '#FF2233',
          400: '#FF2233',
          500: '#FF2233',
          600: '#D91A2B',
        },
        volt: {
          DEFAULT: '#E0202F',
          400: '#E0202F',
          500: '#E0202F',
          600: '#B31527',
        },
        flare: {
          DEFAULT: '#FF1744',
          400: '#FF5A5F',
          500: '#D50000',
        },
        ink: {
          50: '#F7F4F5',
          100: '#ECE7E8',
          200: '#D4CCCA',
          300: '#A9A0A2',
          400: '#81797C',
          500: '#5C5558',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'Roboto', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Arial', 'sans-serif'],
        display: ['var(--font-inter)', 'Roboto', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-roboto-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '6px',
        xl: '6px',
        '2xl': '6px',
        '3xl': '6px',
        full: '9999px',
      },
      backgroundImage: {
        'grid-void':
          'linear-gradient(to right, #150A0D 1px, transparent 1px), linear-gradient(to bottom, #150A0D 1px, transparent 1px)',
      },
      keyframes: {
        'pulse-live': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.35', transform: 'scale(0.82)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-120%)' },
          '100%': { transform: 'translateX(220%)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        enter: {
          '0%': { opacity: '0', transform: 'translateY(14px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'spin-slow': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        ticker: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
      },
      animation: {
        'pulse-live': 'pulse-live 1.4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        shimmer: 'shimmer 1.8s ease-in-out infinite',
        'fade-up': 'fade-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both',
        enter: 'enter 0.5s cubic-bezier(0.22, 1, 0.36, 1) backwards',
        'spin-slow': 'spin-slow 14s linear infinite',
        ticker: 'ticker 42s linear infinite',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
