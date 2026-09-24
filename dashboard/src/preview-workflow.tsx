import { useState } from "react";
import type { PreviewStatus, SecretSetupStatus } from "../../src/contracts";
import type { PreviewReview } from "../../src/dashboard-workflows";
import { call, errorMessage } from "./lib/api";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./components/ui/dialog";
import { Field, FieldLabel, FieldError } from "./components/ui/field";
import { Spinner } from "./components/ui/spinner";
import { Disclosure, Notice, Path, Section } from "./components/shared";

export type LaunchResult = {
  owner: string;
  name: string;
  status: PreviewStatus;
};
export const mutationError = (problem: unknown) =>
  problem instanceof Error && problem.cause
    ? errorMessage(problem)
    : "No response was received. The action may have completed. Recheck status before trying again.";

export function PreviewReviewDialog({
  review,
  onClose,
  onStarted,
  trigger,
}: {
  review: PreviewReview;
  onClose(stale?: boolean): void;
  onStarted(result: LaunchResult): void;
  trigger: HTMLButtonElement | null;
}) {
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose(stale);
      }}
    >
      <DialogContent
        className="workflow-dialog"
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (trigger?.isConnected) trigger.focus();
        }}
      >
        <PreviewReviewStep
          review={review}
          busy={busy}
          setBusy={setBusy}
          onBack={onClose}
          onStarted={onStarted}
          onStale={() => setStale(true)}
        />
      </DialogContent>
    </Dialog>
  );
}

export function PreviewReviewStep({
  review,
  busy,
  setBusy,
  onBack,
  onStarted,
  onStale,
}: {
  review: PreviewReview;
  busy: boolean;
  setBusy(value: boolean): void;
  onBack(stale?: boolean): void;
  onStarted(result: LaunchResult): void;
  onStale?(): void;
}) {
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState("");
  const [needsSecrets, setNeedsSecrets] = useState(false);
  const [stale, setStale] = useState(false);
  const [setup, setSetup] = useState<SecretSetupStatus>();
  const replacement = Boolean(review.existing?.active);
  const spec = review.description.spec;
  const services = spec.type === "environment" ? Object.values(spec.services) : [spec];
  const needsExecution = services.some((service) =>
    ["command", "job", "postgres", "redis", "external-postgres", "external-redis"].includes(service.type),
  );
  const jobs =
    spec.type === "environment"
      ? Object.entries(spec.services).filter(
          ([, service]) => service.type === "job",
        )
      : [];
  const setupPending = setup?.state === "pending" || setup?.state === "saving";
  const needsSetup =
    needsSecrets ||
    review.secretIds.length > 0 ||
    review.managedData.length > 0;
  async function run(action: "launch" | "secrets" | "status") {
    if (busy || !approved) return;
    setBusy(true);
    setError("");
    try {
      if (action === "launch") {
        const result = await call<LaunchResult>({
          action: "previewLaunch",
          id: review.id,
          approved: true,
        });
        onStarted(result);
      } else if (action === "secrets") {
        setSetup(
          await call<SecretSetupStatus>({
            action: "previewSecrets",
            id: review.id,
            approved: true,
            reopen: Boolean(setup) || needsSecrets,
          }),
        );
        setNeedsSecrets(false);
      } else if (setup) {
        setSetup(
          await call<SecretSetupStatus>({
            action: "previewSetupStatus",
            id: review.id,
            requestId: setup.id,
          }),
        );
      }
    } catch (problem) {
      const cause = problem instanceof Error ? problem.cause : undefined;
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        String(cause.code).startsWith("SECRET_")
      ) {
        setNeedsSecrets(true);
        setSetup(undefined);
      }
      if (
        cause &&
        typeof cause === "object" &&
        "code" in cause &&
        ["STALE_ATTEMPT", "NOT_FOUND"].includes(String(cause.code))
      ) {
        setStale(true);
        onStale?.();
      }
      setError(
        action === "status" ? errorMessage(problem) : mutationError(problem),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {replacement ? "Apply configuration" : "Start preview"}
        </DialogTitle>
        <DialogDescription>
          Review <strong>{spec.name}</strong> in this project before{" "}
          {replacement ? "replacing the preview" : "starting it"}.
        </DialogDescription>
        <Path value={review.project} />
      </DialogHeader>
      <div className="workflow-body scroll-panel">
        <p className="workflow-origin">
          {review.file ? (
            <>
              From <code className="break-anywhere">{review.file}</code>
            </>
          ) : (
            "Uses the reviewed configuration. No recipe file is saved."
          )}
        </p>
        {replacement && (
          <Notice title="Replaces the whole preview">
            Services start with the reviewed configuration.{" "}
            {review.existing?.active
              ? "The current app keeps serving until the replacement is ready. "
              : ""}
            Database changes and job writes cannot be rolled back.
          </Notice>
        )}
        {review.existing && !replacement && (
          <Notice title="Preview already exists">
            This starts the existing preview in this project with the reviewed
            configuration. Its managed data is retained.
          </Notice>
        )}
        <Section title="Source folders">
          {review.sources.length ? (
            <div className="source-folders">
              {review.sources.map((source) => (
                <Path key={source} value={source} />
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">No local source folders.</p>
          )}
        </Section>
        {!!review.commands.length && (
          <Section title="Commands">
            <div className="definitions">
              {review.commands.map((command, i) => (
                <pre className="workflow-command" key={i}>
                  {command}
                </pre>
              ))}
            </div>
          </Section>
        )}
        {!!jobs.length && (
          <Section title="Startup jobs">
            <div className="workflow-list">
              {jobs.map(([name, job]) => (
                <p key={name}>
                  <code>{name}</code> —{" "}
                  {job.run === "once"
                    ? "Once per retained environment"
                    : "Every start"}
                </p>
              ))}
            </div>
            {jobs.some(([, job]) => job.run === "once") && (
              <p className="text-muted-foreground">
                Once jobs require an explicit rerun after failure.
              </p>
            )}
          </Section>
        )}
        {!!review.managedData.length && (
          <Section title="Managed data">
            <p>{review.managedData.join(", ")}</p>
            <p className="text-muted-foreground">
              Data belongs to this project and preview. Existing data is
              retained.
            </p>
          </Section>
        )}
        {!!review.secretIds.length && (
          <Section title="Secret references">
            <div className="workflow-list">
              {review.secretIds.map((id) => (
                <code key={id}>{id}</code>
              ))}
            </div>
            <p className="text-muted-foreground">
              Approve access and enter missing values in the private setup form.
              Stored values are never shown here.
            </p>
          </Section>
        )}
        {!!review.inspection.prerequisites?.length && (
          <Notice title="Prerequisites to check">
            {review.inspection.prerequisites.map((finding, i) => (
              <p key={i}>
                {finding.service && (
                  <>
                    <code>{finding.service}</code>:{" "}
                  </>
                )}
                {finding.message}
              </p>
            ))}
          </Notice>
        )}
        {review.inspectionError && (
          <Notice title="Some checks could not complete" error>
            {review.inspectionError}
          </Notice>
        )}
        <Disclosure title="Reviewed configuration">
          <pre className="configuration">{JSON.stringify(spec, null, 2)}</pre>
        </Disclosure>
        {review.executionBlocked && (
          <Notice title="Execution permission required" error>
            {review.executionBlocked}
          </Notice>
        )}
        <Field orientation="horizontal" className="workflow-consent">
          <Checkbox
            id="preview-approval"
            checked={approved}
            disabled={busy || Boolean(setup) || Boolean(review.executionBlocked)}
            onCheckedChange={(value) => setApproved(value === true)}
          />
          <FieldLabel htmlFor="preview-approval">
            {needsExecution
              ? "Allow commands and database access for this project, including future previews, and access to the listed source folders. Secret access is approved separately."
              : "Allow this preview to use the listed source folders."}
          </FieldLabel>
        </Field>
        {setup && (
          <Notice
            title={
              setup.state === "complete"
                ? "Private setup complete"
                : setup.state === "canceled"
                  ? "Private setup canceled"
                  : setup.state === "expired"
                    ? "Private setup expired"
                    : "Private setup"
            }
            error={setup.state === "partial"}
          >
            {setup.state === "complete"
              ? "Continue when you are ready to start with the reviewed configuration."
              : setupPending
                ? "Complete or cancel setup in the private form, then check its status here. Closing this review does not cancel the private form."
                : "The new configuration has not started. Open a new private request to continue."}
            {setup.browser === "failed" && (
              <p>
                The browser did not open. Use Open private form to try again.
              </p>
            )}
            {setup.error && <p>{setup.error.message}</p>}
          </Notice>
        )}
        {error && <FieldError>{error}</FieldError>}
        {stale && (
          <p className="text-muted-foreground">
            Go back and review the current configuration again before starting.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => onBack(stale)}>
          Back
        </Button>
        {setupPending && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run("secrets")}
          >
            Open private form
          </Button>
        )}
        <Button
          disabled={busy || !approved || stale || Boolean(review.executionBlocked)}
          onClick={() =>
            void run(
              setupPending
                ? "status"
                : (setup && setup.state !== "complete") ||
                    (needsSetup && !setup)
                  ? "secrets"
                  : "launch",
            )
          }
        >
          {busy && <Spinner data-icon="inline-start" />}
          {busy
            ? "Working…"
            : setupPending
              ? "Check setup"
              : setup?.state === "complete"
                ? replacement
                  ? "Apply configuration"
                  : "Start preview"
                : setup || needsSetup
                  ? "Continue to private setup"
                  : replacement
                    ? "Apply configuration"
                    : "Start preview"}
        </Button>
      </DialogFooter>
    </>
  );
}
