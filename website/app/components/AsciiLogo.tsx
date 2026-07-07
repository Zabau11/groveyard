const groveyardAscii = `  ____                                      __
 / ___|_ __ _____   _____ _   _  __ _ _ __ __| |
| |  _| '__/ _ \\ \\ / / _ \\ | | |/ _\` | '__/ _\` |
| |_| | | | (_) \\ V /  __/ |_| | (_| | | | (_| |
 \\____|_|  \\___/ \\_/ \\___|\\__, |\\__,_|_|  \\__,_|
                          |___/`;

type AsciiLogoProps = {
  className?: string;
  decorative?: boolean;
};

export function AsciiLogo({ className = "", decorative = false }: AsciiLogoProps) {
  return (
    <pre
      aria-hidden={decorative ? "true" : undefined}
      aria-label={decorative ? undefined : "Groveyard"}
      className={`ascii-logo ${className}`.trim()}
      role={decorative ? undefined : "img"}
    >
      {groveyardAscii}
    </pre>
  );
}
