import { createContext, useContext, useState } from 'react';

interface Settings {
  selectedModel: string;
  setSelectedModel: (m: string) => void;
  chunkingModel: string;
  setChunkingModel: (m: string) => void;
  selectedRuleSetId: number | null;
  setSelectedRuleSetId: (id: number | null) => void;
}

const defaults: Settings = {
  selectedModel: 'claude-sonnet-4-6',
  setSelectedModel: () => {},
  chunkingModel: 'claude-haiku-4-5-20251001',
  setChunkingModel: () => {},
  selectedRuleSetId: null,
  setSelectedRuleSetId: () => {},
};

export const SettingsContext = createContext<Settings>(defaults);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [selectedModel, setSelectedModelState] = useState<string>(
    () => localStorage.getItem('settings_model') || 'claude-sonnet-4-6'
  );
  const [chunkingModel, setChunkingModelState] = useState<string>(
    () => localStorage.getItem('settings_chunking_model') || 'claude-haiku-4-5-20251001'
  );
  const [selectedRuleSetId, setSelectedRuleSetIdState] = useState<number | null>(() => {
    const v = localStorage.getItem('settings_ruleset');
    return v ? Number(v) : null;
  });

  function setSelectedModel(m: string) {
    setSelectedModelState(m);
    localStorage.setItem('settings_model', m);
  }

  function setChunkingModel(m: string) {
    setChunkingModelState(m);
    localStorage.setItem('settings_chunking_model', m);
  }

  function setSelectedRuleSetId(id: number | null) {
    setSelectedRuleSetIdState(id);
    if (id == null) localStorage.removeItem('settings_ruleset');
    else localStorage.setItem('settings_ruleset', String(id));
  }

  return (
    <SettingsContext.Provider
      value={{ selectedModel, setSelectedModel, chunkingModel, setChunkingModel, selectedRuleSetId, setSelectedRuleSetId }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
