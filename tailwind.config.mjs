/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        vs: {
          bg:      '#0f0f0f',
          surface: '#1a1a1a',
          border:  '#2d2d2d',
          hover:   '#1e1e1e',
          modal:   '#0a0a0a',
          detail:  '#121212',
          thead:   '#151515',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
