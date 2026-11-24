import { useState } from 'react';
import { LANGS, LANG_LABELS, type Lang, type MultiLangText } from '../lib/recipes';

interface Props {
  label: string;
  value: MultiLangText;
  onChange: (value: MultiLangText) => void;
  required?: boolean;
  placeholder?: string;
  multiline?: boolean;
}

export function MultilingualField({
  label,
  value,
  onChange,
  required,
  placeholder,
  multiline,
}: Props) {
  const [activeLang, setActiveLang] = useState<Lang>('de');

  const handleChange = (lang: Lang, text: string) => {
    onChange({ ...value, [lang]: text });
  };

  const inputProps = {
    value: value[activeLang] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      handleChange(activeLang, e.target.value),
    placeholder,
    className:
      'w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary text-sm',
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-sm font-medium text-slate-700">
          {label}
          {required && activeLang === 'de' && <span className="text-red-500 ml-0.5">*</span>}
          <span className="ml-2 text-xs text-slate-400 font-normal">
            ({LANG_LABELS[activeLang]})
          </span>
        </label>
        <div className="flex gap-1">
          {LANGS.map((lang) => {
            const isActive = activeLang === lang;
            const hasContent = (value[lang]?.trim().length ?? 0) > 0;
            return (
              <button
                key={lang}
                type="button"
                onClick={() => setActiveLang(lang)}
                className={
                  'px-2 py-0.5 rounded text-xs font-medium uppercase transition ' +
                  (isActive
                    ? 'bg-primary text-white'
                    : hasContent
                      ? 'bg-primary-light text-primary hover:bg-primary-light/80'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200')
                }
              >
                {lang}
              </button>
            );
          })}
        </div>
      </div>
      {multiline ? <textarea rows={3} {...inputProps} /> : <input type="text" {...inputProps} />}
    </div>
  );
}
