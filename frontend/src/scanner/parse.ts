const ACCESSION_PATTERN = /^[A-Z]+-\d{4}-\d{4,}$/;

function accessionFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/e\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }

  try {
    const accession = decodeURIComponent(match[1]);
    return ACCESSION_PATTERN.test(accession) ? accession : null;
  } catch {
    return null;
  }
}

export function parseAccession(text: string): string | null {
  const input = text.trim();
  if (ACCESSION_PATTERN.test(input)) {
    return input;
  }

  if (input.startsWith("/")) {
    try {
      return accessionFromPath(new URL(input, "https://autolab.local").pathname);
    } catch {
      return null;
    }
  }

  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return accessionFromPath(url.pathname);
  } catch {
    return null;
  }
}
