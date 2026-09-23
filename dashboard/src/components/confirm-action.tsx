import { useEffect, useState, type ReactNode } from "react";
import type { Mutate, MutationResult } from "../lib/api";
import type { AttemptSummary, PreviewStatus } from "../../../src/contracts";
import { attempts } from "../lib/model";
import { Spinner } from "./ui/spinner";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldLabel } from "./ui/field";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "./ui/alert-dialog";

export type Confirmation = {
  title: string;
  blocked?: string;
  acknowledgement?: string;
  description: string;
  details?: ReactNode;
  body: object;
  message: string;
  confirmLabel: string;
};

export function ConfirmAction({
  label,
  accessibleLabel,
  danger = false,
  disabled,
  request,
  mutate,
}: {
  label: string;
  accessibleLabel?: string;
  danger?: boolean;
  disabled: boolean;
  request: Confirmation;
  mutate: Mutate;
}) {
  // Polling must not change the operation the user is currently reviewing.
  const [review, setReview] = useState<Confirmation>();
  return (
    <AlertDialog
      open={Boolean(review)}
      onOpenChange={(open) => setReview(open ? request : undefined)}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant={danger ? "destructive" : "outline"}
          size="sm"
          disabled={disabled}
          aria-label={accessibleLabel}
        >
          {label}
        </Button>
      </AlertDialogTrigger>
      <ConfirmationContent
        review={review}
        disabled={disabled}
        danger={danger}
        mutate={mutate}
        onComplete={() => setReview(undefined)}
      />
    </AlertDialog>
  );
}

export function ConfirmationContent({
  review,
  disabled,
  danger = false,
  mutate,
  onCloseAutoFocus,
  onComplete,
  preview,
}: {
  review?: Confirmation;
  preview?: PreviewStatus;
  onComplete: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  disabled: boolean;
  danger?: boolean;
  mutate: Mutate;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<
    "pending" | MutationResult<PreviewStatus | null>
  >();
  useEffect(() => {
    setConfirmed(false);
    setOutcome(undefined);
  }, [review]);
  const pending = outcome === "pending";
  const action =
    review && "action" in review.body ? review.body.action : undefined;
  const reset = action === "resetData";
  const candidate =
    outcome && outcome !== "pending" && outcome.ok && reset
      ? outcome.result?.candidate
      : undefined;
  const currentAttempt =
    candidate && attempts(preview).find((item) => item.id === candidate.id);
  // The POST confirms deletion and requests startup. Only that startup's result applies here.
  const attempt = currentAttempt ?? candidate;
  const error =
    outcome && outcome !== "pending" && !outcome.ok ? outcome.error : undefined;
  async function submit() {
    if (!review || outcome) return;
    setOutcome("pending");
    const result = await mutate<PreviewStatus | null>(review.body);
    setOutcome(result);
    if (result.ok && !reset && action !== "deleteData") onComplete();
  }
  return review ? (
    <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
      <AlertDialogHeader>
        <AlertDialogTitle>{review.title}</AlertDialogTitle>
        <AlertDialogDescription
          asChild
          className={outcome ? "text-foreground" : undefined}
        >
          {outcome ? (
            <div
              role={error || attempt?.state === "failed" ? "alert" : "status"}
              className="flex flex-col gap-2 text-sm"
            >
              {pending ? (
                <p className="flex items-center gap-2">
                  <Spinner />
                  {reset ? "Stopping and deleting managed data…" : "Working…"}
                </p>
              ) : error ? (
                <p className="text-destructive">{error}</p>
              ) : reset ? (
                <>
                  <p>Data deleted. {resetStatus(attempt)}</p>
                  {attempt?.error && (
                    <p className="text-destructive">{attempt.error.message}</p>
                  )}
                  {attempt?.state === "failed" && (
                    <p>
                      Fix the error, then retry startup. Data will not be
                      deleted again.
                    </p>
                  )}
                </>
              ) : (
                <p>{review.message}</p>
              )}
            </div>
          ) : (
            <p>{review.description}</p>
          )}
        </AlertDialogDescription>
      </AlertDialogHeader>
      {review.details}
      {review.blocked ? (
        <p role="alert" className="text-sm text-destructive">
          {review.blocked}
        </p>
      ) : review.acknowledgement && !outcome ? (
        <Field orientation="horizontal">
          <Checkbox
            id="cleanup-verified"
            checked={confirmed}
            onCheckedChange={(value) => setConfirmed(value === true)}
          />
          <FieldLabel htmlFor="cleanup-verified">
            {review.acknowledgement}
          </FieldLabel>
        </Field>
      ) : null}
      {pending && (
        <p className="text-xs text-muted-foreground">
          Closing does not cancel this action.
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel>{outcome ? "Close" : "Cancel"}</AlertDialogCancel>
        {!outcome && (
          <AlertDialogAction
            variant={danger ? "destructive" : "default"}
            disabled={
              disabled ||
              !!review.blocked ||
              (!!review.acknowledgement && !confirmed)
            }
            onClick={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {review.confirmLabel}
          </AlertDialogAction>
        )}
      </AlertDialogFooter>
    </AlertDialogContent>
  ) : null;
}

function resetStatus(attempt: AttemptSummary | undefined): string {
  switch (attempt?.state) {
    case "ready":
      return "Preview ready.";
    case "failed":
      return "Startup failed.";
    case "canceled":
      return "Startup canceled.";
    case "stopped":
      return "Preview stopped.";
    case "cleanup-incomplete":
      return "Cleanup needs attention.";
    default:
      return "Startup requested.";
  }
}
