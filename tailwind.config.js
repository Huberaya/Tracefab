/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './dpp/**/*.{html,js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        forest: {
          50: '#f4f7f4',
          100: '#e5eee6',
          200: '#cedecf',
          500: '#2d5a3c',
          600: '#23472f',
          700: '#1b3724',
          800: '#142a1b',
          900: '#0c1b11',
          950: '#07100a',
        },
        sand: {
          50: '#faf8f5',
          100: '#f3efe8',
          200: '#e6ded2',
          300: '#d5c7b3',
        },
      },
      fontFamily: {
        sans: ['Inter Tight', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
