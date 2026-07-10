import * as React from 'react';
import type { LLMConfig, LLMProvider } from '../../../src/chat/types';
import { sendMessage } from '../vscodeApi';

interface SettingsPanelProps {
	config: LLMConfig | null;
	onClose: () => void;
}

const PROVIDERS: { value: LLMProvider; label: string; defaultModel: string }[] = [
	{ value: 'claude', label: 'Claude', defaultModel: 'claude-sonnet-4-7-20251001' },
	{ value: 'openai', label: 'OpenAI', defaultModel: 'gpt-4.1' },
	{ value: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat' },
];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ config, onClose }) => {
	const [provider, setProvider] = React.useState<LLMProvider>(config?.provider ?? 'claude');
	const [model, setModel] = React.useState(config?.model ?? PROVIDERS[0].defaultModel);
	const [apiKey, setApiKey] = React.useState('');
	const [apiUrl, setApiUrl] = React.useState(config?.apiUrl ?? '');

	const handleProviderChange = (next: LLMProvider) => {
		setProvider(next);
		const def = PROVIDERS.find((p) => p.value === next)?.defaultModel ?? '';
		setModel(def);
	};

	const handleSave = () => {
		sendMessage({
			type: 'saveLLMConfig',
			provider,
			model: model.trim() || PROVIDERS.find((p) => p.value === provider)!.defaultModel,
			apiKey: apiKey.trim() || undefined,
			apiUrl: apiUrl.trim() || undefined,
		});
		onClose();
	};

	return (
		<div
			style={{
				position: 'absolute',
				inset: 0,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				background: 'rgba(0,0,0,0.4)',
				zIndex: 100,
			}}
		>
			<div
				style={{
					background: 'var(--vscode-editor-background)',
					border: '1px solid var(--vscode-panel-border)',
					borderRadius: '8px',
					padding: '20px',
					width: '320px',
					maxWidth: '90%',
				}}
			>
				<h3 style={{ margin: '0 0 16px', fontSize: '14px' }}>LLM Settings</h3>

				<label style={{ display: 'block', marginBottom: '12px', fontSize: '12px' }}>
					Provider
					<select
						value={provider}
						onChange={(e) => handleProviderChange(e.target.value as LLMProvider)}
						style={{
							display: 'block',
							width: '100%',
							marginTop: '4px',
							padding: '6px 8px',
							borderRadius: '4px',
							border: '1px solid var(--vscode-input-border)',
							background: 'var(--vscode-input-background)',
							color: 'var(--vscode-input-foreground)',
						}}
					>
						{PROVIDERS.map((p) => (
							<option key={p.value} value={p.value}>
								{p.label}
							</option>
						))}
					</select>
				</label>

				<label style={{ display: 'block', marginBottom: '12px', fontSize: '12px' }}>
					Model
					<input
						type="text"
						value={model}
						onChange={(e) => setModel(e.target.value)}
						placeholder="e.g. gpt-4.1"
						style={{
							display: 'block',
							width: '100%',
							marginTop: '4px',
							padding: '6px 8px',
							borderRadius: '4px',
							border: '1px solid var(--vscode-input-border)',
							background: 'var(--vscode-input-background)',
							color: 'var(--vscode-input-foreground)',
							boxSizing: 'border-box',
						}}
					/>
				</label>

				<label style={{ display: 'block', marginBottom: '12px', fontSize: '12px' }}>
					API URL (optional)
					<input
						type="text"
						value={apiUrl}
						onChange={(e) => setApiUrl(e.target.value)}
						placeholder="Leave blank for default"
						style={{
							display: 'block',
							width: '100%',
							marginTop: '4px',
							padding: '6px 8px',
							borderRadius: '4px',
							border: '1px solid var(--vscode-input-border)',
							background: 'var(--vscode-input-background)',
							color: 'var(--vscode-input-foreground)',
							boxSizing: 'border-box',
						}}
					/>
				</label>

				<label style={{ display: 'block', marginBottom: '16px', fontSize: '12px' }}>
					API Key
					<input
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder={config?.apiKeySet ? 'Leave blank to keep current key' : 'sk-...'}
						style={{
							display: 'block',
							width: '100%',
							marginTop: '4px',
							padding: '6px 8px',
							borderRadius: '4px',
							border: '1px solid var(--vscode-input-border)',
							background: 'var(--vscode-input-background)',
							color: 'var(--vscode-input-foreground)',
							boxSizing: 'border-box',
						}}
					/>
				</label>

				<div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
					<button
						onClick={onClose}
						style={{
							padding: '6px 16px',
							borderRadius: '4px',
							border: '1px solid var(--vscode-input-border)',
							background: 'transparent',
							color: 'var(--vscode-foreground)',
							cursor: 'pointer',
						}}
					>
						Cancel
					</button>
					<button
						onClick={handleSave}
						style={{
							padding: '6px 16px',
							borderRadius: '4px',
							border: 'none',
							background: 'var(--vscode-button-background)',
							color: 'var(--vscode-button-foreground)',
							cursor: 'pointer',
						}}
					>
						Save
					</button>
				</div>
			</div>
		</div>
	);
};
