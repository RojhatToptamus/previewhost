import { useEffect, useRef, useState } from "react";
import type { PreviewReview } from "../../src/dashboard-workflows";
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
import { Notice } from "./components/shared";
import { PreviewReviewStep, type LaunchResult } from "./preview-workflow";

export function NewPreview({
  onClose,
  onStarted,
}: {
  onClose(): void;
  onStarted(result: LaunchResult): void;
}) {
  const [projects, setProjects] = useState<
    Array<{ directory: string; branch?: string }>
  >([]);
  const [project, setProject] = useState("");
  const [choice, setChoice] = useState("custom");
  const [mode, setMode] = useState("file");
  const [format, setFormat] = useState("yaml");
  const [file, setFile] = useState("");
  const [loading, setLoading] = useState(true);
  const [projectError, setProjectError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<PreviewReview>();
  const text = useRef<HTMLTextAreaElement>(null);
  const sourceText = useRef("");
  const opener = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    const controller = new AbortController();
    void call<{ projects: typeof projects }>(
      { action: "previewProjects" },
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setProjects(result.projects);
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
          if (opener.current?.isConnected) opener.current.focus();
        }}
      >
        {review ? (
          <PreviewReviewStep
            key={review.id}
            review={review}
            busy={busy}
            setBusy={setBusy}
            onBack={() => setReview(undefined)}
            onStarted={onStarted}
          />
        ) : (
          <form onSubmit={prepare} className="workflow-form">
            <DialogHeader>
              <DialogTitle>New preview</DialogTitle>
              <DialogDescription>
                Choose an existing worktree or project folder, then review its
                configuration before starting.
              </DialogDescription>
            </DialogHeader>
            <div className="workflow-body scroll-panel">
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
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="custom">
                          Enter a folder path
                        </SelectItem>
                        {projects.map((item) => (
                          <SelectItem
                            key={item.directory}
                            value={item.directory}
                          >
                            {item.branch ? `${item.branch} · ` : ""}
                            {item.directory}
                          </SelectItem>
                        ))}
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
                    The folder can be a Git worktree or any existing local
                    directory. Other source folders declared in the
                    configuration are reviewed next.
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
                      Leave empty to use preview.yaml or preview.yml. A relative
                      path starts from this project folder.
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
                        Accepts the full Previewhost schema: static, command,
                        attach, or a multi-service environment. Relative source
                        paths start from the selected folder. Use{" "}
                        <code>{"{secret: reference}"}</code> for credentials. No
                        recipe file is saved.
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
