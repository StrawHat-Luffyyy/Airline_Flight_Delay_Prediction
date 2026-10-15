import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '../api/client';

interface QueryStateProps<T> {
  query: Pick<UseQueryResult<T, Error>, 'data' | 'isPending' | 'isError' | 'error' | 'refetch'>;
  children: (data: T) => ReactNode;
  /** Returns true when the loaded data has nothing to show. */
  isEmpty?: (data: T) => boolean;
  emptyMessage?: string;
  /** Extra guidance for a given error, e.g. how to register the model. */
  hint?: (error: ApiError) => string | undefined;
  /** Height of the loading placeholder, as a Tailwind class. */
  skeletonClass?: string;
  /** Short name of the block, used in messages ("Could not load the cause breakdown"). */
  label?: string;
}

export function Skeleton({ className = 'h-40' }: { className?: string }) {
  return <div className={`skeleton w-full ${className}`} aria-hidden="true" />;
}

export function ErrorBlock({
  error,
  onRetry,
  label,
  hint,
}: {
  error: Error | null;
  onRetry?: () => void;
  label?: string;
  hint?: string;
}) {
  const apiError = error instanceof ApiError ? error : null;
  return (
    <div
      role="alert"
      className="border-y border-rule py-5 text-sm"
      data-error-code={apiError?.code}
    >
      <p className="text-cancelled">
        {label ? `Could not load ${label}.` : 'Could not load this data.'}
      </p>
      <p className="mt-1 max-w-[65ch] text-ink-2">{error?.message ?? 'Unknown error.'}</p>
      {hint ? <p className="mt-1 max-w-[65ch] text-ink-3">{hint}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-full border border-rule-strong px-4 py-1.5 text-ink hover:bg-wash"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyBlock({ message }: { message: string }) {
  return (
    <div className="border-y border-rule py-6 text-sm text-ink-2" role="status">
      {message}
    </div>
  );
}

/** Loading, error (with Retry) and empty states for any query-backed block. */
export function QueryState<T>({
  query,
  children,
  isEmpty,
  emptyMessage = 'Nothing to show for this selection.',
  hint,
  skeletonClass,
  label,
}: QueryStateProps<T>) {
  if (query.isError) {
    const apiError = query.error instanceof ApiError ? query.error : undefined;
    return (
      <ErrorBlock
        error={query.error}
        label={label}
        hint={apiError ? hint?.(apiError) : undefined}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data === undefined) {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">{label ? `Loading ${label}` : 'Loading'}</span>
        <Skeleton className={skeletonClass} />
      </div>
    );
  }
  if (isEmpty?.(query.data)) return <EmptyBlock message={emptyMessage} />;
  return <>{children(query.data)}</>;
}
