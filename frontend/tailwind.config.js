/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        serif: ["Newsreader", "Instrument Serif", "Georgia", "serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        workbench: {
          canvas: "#09090B",
          panel: "#111113",
          elevated: "#141416",
          hover: "#18181B",
          hairline: "rgba(255, 255, 255, 0.07)",
          "hairline-bright": "rgba(255, 255, 255, 0.12)",
          amber: "#F59E0B",
          emerald: "#10B981",
          primary: "#EDEDED",
          secondary: "#A1A1AA",
          muted: "#52525B",
        },
      },
      boxShadow: {
        keycap: "0 1px 2px 0 rgba(0, 0, 0, 0.5), inset 0 1px 0 0 rgba(255, 255, 255, 0.08)",
        card: "0 8px 24px -4px rgba(0, 0, 0, 0.75)",
      },
    },
  },
  plugins: [],
}
