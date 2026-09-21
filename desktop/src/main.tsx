import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Liquid Glass design system — layered AFTER index.css so it refines the
// existing palette/typography without breaking class names. See docs/DESIGN_SYSTEM.md.
import './styles/tokens.css'
import './styles/glass.css'
// Screen furniture (page header, card, stat, table, chip, tabs, modal). Last, so
// a screen only has to reach for a class name to match the mockup.
import './styles/elegance.css'
import App from './App.tsx'
import { ThemeProvider } from './ThemeContext'
import { LanguageProvider } from './LanguageContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </LanguageProvider>
  </StrictMode>,
)
