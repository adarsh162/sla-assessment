/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        base: '#10141A',
        panel: '#171D24',
        line: '#262E37',
        ink: '#E7ECEF',
        muted: '#8A97A3',
        ok: '#4CC38A',
        warn: '#E0A43F',
        bad: '#E5484D',
        accent: '#2C7A93',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
