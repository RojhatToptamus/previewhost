import { useEffect, useRef, useState } from "react";
import type { PreviewReview, PreviewReviewSummary } from "../../src/dashboard-workflows";
import { call, errorMessage } from "./lib/api";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "./components/ui/field";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "./components/ui/select";
import { Spinner } from "./components/ui/spinner";
import { CopyButton, Notice, Path, Section } from "./components/shared";
import { PreviewReviewStep, type LaunchResult } from "./preview-workflow";

export function NewPreview({
  onClose,
  onStarted,
  project: initialProject = "",
  resumeId,
}: {
  project?: string;
  resumeId?: string;
  onClose(): void;
  onStarted(result: LaunchResult): void;
}) {
  const [projects, setProjects] = useState<
    Array<{ directory: string; branch?: string }>
  >([]);
  const [project, setProject] = useState(initialProject);
  const [choice, setChoice] = useState("custom");
  const [mode, setMode] = useState("file");
  const [format, setFormat] = useState("yaml");
  const [file, setFile] = useState("");
  const [loading, setLoading] = useState(true);
  const [projectError, setProjectError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviews, setReviews] = useState<PreviewReviewSummary[]>([]);
  const [review, setReview] = useState<PreviewReview>();
  const text = useRef<HTMLTextAreaElement>(null);
  const sourceText = useRef("");
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    const controller = new AbortController();
    void call<{ projects: typeof projects; reviews: PreviewReviewSummary[] }>(
      { action: "previewProjects" },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setProjects(result.projects);
          setReviews(result.reviews);
        }
      })
      .catch((problem) => {
        if (!controller.signal.aborted) setProjectError(errorMessage(problem));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      sourceText.current = "";
      if (text.current) text.current.value = "";
    };
  }, []);
  useEffect(() => {
    if (resumeId) void resume(resumeId);
  }, [resumeId]);
  async function resume(id: string) {
    setBusy(true);
    setError("");
    try {
      setReview(await call<PreviewReview>({ action: "previewResume", id }));
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  const unfinished = reviews.filter(item => !initialProject || item.project === initialProject);
  const agentPrompt = `Inspect ${project.trim() || "this project"} and prepare Previewhost YAML for the dashboard using https://www.previewhost.app/configuration/. Read the project instructions and identify the frontend, backend, database, migrations, seeds, source folders, and service connections. Reuse a valid preview.yaml or preview.yml when appropriate; diagnose invalid files. Use project-specific secret references, never secret values. Ask only for information you cannot determine. Return the YAML and any required prerequisites. Do not write files or start the application.`;
  async function prepare(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const input = {
      action: "previewPrepare",
      project: project.trim(),
      ...(mode === "file"
        ? { file: file.trim() || undefined }
        : { text: text.current?.value ?? "", format }),
    };
    try {
      const result = await call<PreviewReview>(input);
      setReview(result);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      if ("text" in input) input.text = "";
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="workflow-dialog"
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected && !opener.current.closest('[role="dialog"][data-state="closed"]')) opener.current.focus();
          else document.querySelector<HTMLButtonElement>('[data-slot="sidebar-trigger"]')?.focus();
        }}
      >
        {review ? (
          <PreviewReviewStep
            key={review.id}
            review={review}
            busy={busy}
            setBusy={setBusy}
            onBack={() => setReview(undefined)}
            onClose={onClose}
            onStarted={onStarted}
          />
        ) : (
          <form onSubmit={prepare} className="workflow-form">
            <DialogHeader>
              <DialogTitle>New preview</DialogTitle>
              <DialogDescription>
                Choose a folder and configuration, then review before starting.
              </DialogDescription>
            </DialogHeader>
            <div className="workflow-body scroll-panel">
              {!!unfinished.length && (
                <Section title="Continue setup">
                  <div className="definitions">
                    {unfinished.map(item => (
                      <div key={item.id} className="flex items-center justify-between gap-3 py-2">
                        <div className="min-w-0 flex flex-col gap-1">
                          <strong>{item.name}</strong>
                          <Path value={item.project} />
                          <span className="text-muted-foreground text-xs">{item.file ? "From file" : "Pasted configuration"} · Available until {new Date(item.expiresAt).toLocaleTimeString()}</span>
                        </div>
                        <Button type="button" variant="outline" disabled={busy} onClick={() => void resume(item.id)}>Review</Button>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="project-choice">
                    Project folder
                  </FieldLabel>
                  <Select
                    value={choice}
                    onValueChange={(value) => {
                      setChoice(value);
                      setProject(value === "custom" ? "" : value);
                      setError("");
                    }}
                    disabled={busy}
                  >
                    <SelectTrigger id="project-choice">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="project-picker">
                      <SelectGroup>
                        <SelectItem value="custom">
                          Enter a folder path
                        </SelectItem>
                        {projects.map((item) => {
                          const folder = item.directory.split("/").filter(Boolean).at(-1) ?? item.directory;
                          const label = [folder, item.branch].filter(Boolean).join(" · ");
                          return (
                          <SelectItem
                            key={item.directory}
                            value={item.directory}
                            textValue={label}
                            aria-labelledby={undefined}
                            aria-label={[item.branch, item.directory].filter(Boolean).join(" · ")}
                          >
                            <span className="project-choice">
                              <span className="project-branch">{label}</span>
                              <Path value={item.directory} />
                            </span>
                          </SelectItem>
                        ); })}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {loading && (
                    <FieldDescription role="status">
                      Loading known projects and registered worktrees…
                    </FieldDescription>
                  )}
                  <Input
                    aria-label="Absolute project folder"
                    value={project}
                    onChange={(event) => {
                      setProject(event.target.value);
                      setChoice("custom");
                      setError("");
                    }}
                    placeholder="/absolute/path/to/project"
                    required
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <FieldDescription>
                    Use an existing worktree or local folder.
                  </FieldDescription>
                </Field>
                {projectError && (
                  <Notice title="Known folders unavailable">
                    {projectError} You can still enter a folder path.
                  </Notice>
                )}
                <Field>
                  <FieldLabel htmlFor="preview-input-mode">
                    Configuration
                  </FieldLabel>
                  <Select
                    value={mode}
                    onValueChange={(value) => {
                      setMode(value);
                      setError("");
                    }}
                    disabled={busy}
                  >
                    <SelectTrigger id="preview-input-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="file">
                          Existing configuration file
                        </SelectItem>
                        <SelectItem value="text">
                          YAML or JSON without a file
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap items-center gap-3">
                    <a className="text-muted-foreground underline underline-offset-4" href="https://www.previewhost.app/configuration/" target="_blank" rel="noopener noreferrer">Configuration guide</a>
                    <span className="flex items-center gap-1 text-muted-foreground">Ask an agent to prepare it <CopyButton value={agentPrompt} label="Copy configuration prompt" /></span>
                  </div>
                </Field>
                {mode === "file" ? (
                  <Field>
                    <FieldLabel htmlFor="preview-file">File path</FieldLabel>
                    <Input
                      id="preview-file"
                      value={file}
                      onChange={(event) => {
                        setFile(event.target.value);
                        setError("");
                      }}
                      placeholder="preview.yaml or preview.json"
                      disabled={busy}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <FieldDescription>
                      Defaults to preview.yaml or preview.yml in this folder.
                    </FieldDescription>
                  </Field>
                ) : (
                  <>
                    <Field>
                      <FieldLabel htmlFor="preview-format">Format</FieldLabel>
                      <Select
                        value={format}
                        onValueChange={(value) => {
                          setFormat(value);
                          setError("");
                        }}
                        disabled={busy}
                      >
                        <SelectTrigger id="preview-format">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="yaml">YAML</SelectItem>
                            <SelectItem value="json">JSON</SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="preview-text">
                        Preview configuration
                      </FieldLabel>
                      <Textarea
                        id="preview-text"
                        ref={text}
                        defaultValue={sourceText.current}
                        onChange={(event) => {
                          sourceText.current = event.target.value;
                          setError("");
                        }}
                        className="spec-input"
                        placeholder={
                          "name: app\ntype: static\ndirectory: ./public"
                        }
                        required
                        disabled={busy}
                        spellCheck={false}
                        autoComplete="off"
                        autoCapitalize="off"
                        autoCorrect="off"
                      />
                      <FieldDescription>
                        Relative paths start from this folder. Use{" "}
                        <code>{"{secret: reference}"}</code> for credentials. No file is saved.
                      </FieldDescription>
                    </Field>
                  </>
                )}
                {error && <FieldError>{error}</FieldError>}
              </FieldGroup>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !project.trim()}>
                {busy && <Spinner data-icon="inline-start" />}
                {busy ? "Reading configuration…" : "Review preview"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
