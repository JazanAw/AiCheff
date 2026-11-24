interface PlaceholderProps {
  title: string;
  description: string;
  sections: string[];
}

export function Placeholder({ title, description, sections }: PlaceholderProps) {
  return (
    <div>
      <h1 className="text-3xl font-bold mb-2">{title}</h1>
      <p className="text-slate-600 mb-8">{description}</p>
      <div className="bg-white p-8 rounded-lg border border-dashed border-slate-300">
        <h2 className="font-semibold mb-3">In Arbeit</h2>
        <ul className="space-y-1 text-slate-600">
          {sections.map((s) => (
            <li key={s}>• {s}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
