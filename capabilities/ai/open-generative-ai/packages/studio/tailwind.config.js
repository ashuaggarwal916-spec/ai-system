/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "var(--font-inter)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
      },
      colors: {
        'app-bg': '#050505',
        'panel-bg': '#0a0a0a',
        'card-bg': '#111111',
        primary: '#22d3ee',
        secondary: '#a1a1aa',
        muted: '#52525b',
      },
    },
  },
  plugins: [],
}
