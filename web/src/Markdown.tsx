import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Renders assistant text as GitHub-flavored markdown. Links open in a new tab.
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
