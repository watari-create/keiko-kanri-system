import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "#F7F5EE",
        paper: "#FFFFFF",
        line: "#E3DECC",
        ink: "#2B2B26",
        muted: "#8A8370",
        matcha: "#5C6B3F",
        "matcha-deep": "#45512E",
        "matcha-pale": "#EAEEDF",
        hanko: "#AC4433",
        "hanko-pale": "#F7E5DF",
      },
    },
  },
  plugins: [],
};
export default config;
