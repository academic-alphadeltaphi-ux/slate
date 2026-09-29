import React from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './styles.css'
import './styles/motion.css'   // SPEC §20.16: the app's one motion layer, last so it can lift the rest
import App from './App.jsx'
if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('electron')
createRoot(document.getElementById('root')).render(<App />)
