import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        "bg": "rgb(var(--c-bg) / <alpha-value>)",
        "paper": "rgb(var(--c-paper) / <alpha-value>)",
        "line": "rgb(var(--c-line) / <alpha-value>)",
        "ink": "rgb(var(--c-ink) / <alpha-value>)",
        "muted": "rgb(var(--c-muted) / <alpha-value>)",
        "matcha": "rgb(var(--c-matcha) / <alpha-value>)",
        "matcha-deep": "rgb(var(--c-matcha-deep) / <alpha-value>)",
        "matcha-pale": "rgb(var(--c-matcha-pale) / <alpha-value>)",
        "hanko": "rgb(var(--c-hanko) / <alpha-value>)",
        "hanko-pale": "rgb(var(--c-hanko-pale) / <alpha-value>)",
        "btn": "rgb(var(--c-btn) / <alpha-value>)",
        "btn-ink": "rgb(var(--c-btn-ink) / <alpha-value>)",
      },
    },
  },
  plugins: [],
};
export default config;
