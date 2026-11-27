// The island engine is plain JS (tidewater + island29); this declares the boot entry for the React shell.
export function bootIslands(
  container: HTMLElement,
  hooks?: {
    onReady?: (app: unknown) => void;
    onTick?: (snapshot: never) => void;
    onDiveRequest?: () => void;
  }
): Promise<unknown>;
export function showLoader(message: string): void;
export function hideLoader(): void;
