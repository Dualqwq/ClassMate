import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) {
	throw new Error('Could not find root container element');
}

// Ensure the root container fills the webview viewport so the React app
// can use percentage heights reliably in both the sidebar and panel.
document.documentElement.style.height = '100%';
document.documentElement.style.margin = '0';
document.documentElement.style.padding = '0';
document.body.style.height = '100%';
document.body.style.margin = '0';
document.body.style.padding = '0';
container.style.height = '100%';

const root = createRoot(container);
root.render(
	<React.StrictMode>
		<App />
	</React.StrictMode>
);
