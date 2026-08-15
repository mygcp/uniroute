import { Form } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/api";
import { KeyRound, ListFilter, Route as RouteIcon, Trash2 } from "lucide-react";
import { query } from "../.server/db";
import { isModelsPublic, setModelsPublic } from "../.server/model-public";
import { getModelSuggestions, getProviderSuggestions } from "../.server/suggest";
import { Combobox } from "../components/ui/combobox";
import { PageHeader } from "../components/ui/page-header";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Label, Select } from "../components/ui/field";
import { Table, THead, THeadCell, TRow, TCell } from "../components/ui/table";
import { Toggle } from "../components/ui/toggle";
import { EmptyState } from "../components/ui/empty-state";

type AllowlistRow = {
  id: number;
  model_name: string;
  action: string;
  reason: string | null;
};

type RuleRow = {
  id: number;
  name: string;
  source_model: string;
  rule_type: string;
  target_model: string | null;
  target_provider_id: string | null;
  priority: number;
  is_active: number;
};

const comboboxClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 h-9";

export function loader() {
  const allowlist = query(
    "SELECT id, model_name, action, reason FROM model_allowlist ORDER BY id DESC",
  ).all() as unknown as AllowlistRow[];
  const rules = query(
    "SELECT id, name, source_model, rule_type, target_model, target_provider_id, priority, is_active FROM routing_rules ORDER BY priority DESC, id DESC",
  ).all() as unknown as RuleRow[];
  const modelsPublic = isModelsPublic();
  const modelSuggestions = getModelSuggestions();
  const providerSuggestions = getProviderSuggestions();
  return {
    allowlist,
    rules,
    modelsPublic,
    modelSuggestions,
    providerSuggestions,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const section = String(form.get("section"));

  if (section === "settings") {
    const intent = String(form.get("intent"));
    if (intent === "models_public") {
      setModelsPublic(form.get("enabled") === "1");
      return null;
    }
  }

  if (section === "allowlist") {
    const intent = String(form.get("intent"));
    if (intent === "delete") {
      query("DELETE FROM model_allowlist WHERE id = ?").run(
        Number(form.get("id")),
      );
      return null;
    }
    query(
      `INSERT INTO model_allowlist (model_name, action, reason)
       VALUES (?, ?, ?)
       ON CONFLICT(model_name, action) DO UPDATE SET reason = excluded.reason`,
    ).run(
      String(form.get("model_name")),
      String(form.get("action")),
      String(form.get("reason") ?? null),
    );
    return null;
  }

  const intent = String(form.get("intent"));
  const id = Number(form.get("id"));
  if (intent === "delete") {
    query("DELETE FROM routing_rules WHERE id = ?").run(id);
    return null;
  }
  if (intent === "toggle") {
    query("UPDATE routing_rules SET is_active = 1 - is_active WHERE id = ?").run(id);
    return null;
  }
  query(
    `INSERT INTO routing_rules
       (name, source_model, rule_type, target_model, target_provider_id, priority, is_active, description)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    String(form.get("name")),
    String(form.get("source_model")),
    String(form.get("rule_type")),
    String(form.get("target_model") ?? null),
    String(form.get("target_provider_id") ?? null),
    Number(form.get("priority") ?? 0),
    String(form.get("description") ?? null),
  );
  return null;
}

export default function Api({ loaderData }: Route.ComponentProps) {
  const {
    allowlist,
    rules,
    modelsPublic,
    modelSuggestions,
    providerSuggestions,
  } = loaderData;

  return (
    <div>
      <PageHeader title="API" icon={<KeyRound size={20} />} />

      <Card className="mb-4">
        <Form
          id="public-models-form"
          method="post"
          className="flex items-center justify-between gap-4"
        >
          <input type="hidden" name="section" value="settings" />
          <input type="hidden" name="intent" value="models_public" />
          <input type="hidden" name="enabled" value={modelsPublic ? "0" : "1"} />
          <div>
            <h3 className="text-sm font-semibold text-foreground">Public Models</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              When enabled, <code>/v1/models</code> can be accessed without auth and only shows
              models marked as <em>public</em>.
            </p>
          </div>
          <Toggle
            checked={modelsPublic}
            label={modelsPublic ? "Disable public models" : "Enable public models"}
            onChange={() => {
              const form = document.getElementById(
                "public-models-form",
              ) as HTMLFormElement | null;
              form?.requestSubmit();
            }}
          />
        </Form>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Model Allowlist ({allowlist.length})</CardTitle>
        </CardHeader>
        <AllowlistForm modelSuggestions={modelSuggestions} />
        {allowlist.length === 0 ? (
          <EmptyState
            icon={<ListFilter size={20} />}
            title="No allowlist entries"
            description="Add a model to allow or deny access to it."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <THeadCell>Model</THeadCell>
                <THeadCell>Action</THeadCell>
                <THeadCell>Reason</THeadCell>
                <THeadCell className="pr-0">Actions</THeadCell>
              </tr>
            </THead>
            <tbody>
              {allowlist.map((row) => (
                <TRow key={row.id}>
                  <TCell className="font-medium text-foreground">{row.model_name}</TCell>
                  <TCell>
                    <Badge tone={row.action === "deny" ? "danger" : "success"}>
                      {row.action}
                    </Badge>
                  </TCell>
                  <TCell className="text-muted-foreground">{row.reason}</TCell>
                  <TCell className="pr-0">
                    <Form method="post">
                      <input type="hidden" name="section" value="allowlist" />
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={row.id} />
                      <Button
                        type="submit"
                        variant="danger"
                        size="icon"
                        aria-label={`Delete ${row.model_name}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </Form>
                  </TCell>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Routing Rules ({rules.length})</CardTitle>
        </CardHeader>
        <RulesForm
          modelSuggestions={modelSuggestions}
          providerSuggestions={providerSuggestions}
        />
        {rules.length === 0 ? (
          <EmptyState
            icon={<RouteIcon size={20} />}
            title="No routing rules"
            description="Add a rule above to control how models are routed."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <THeadCell>Name</THeadCell>
                <THeadCell>Source</THeadCell>
                <THeadCell>Type</THeadCell>
                <THeadCell>Target</THeadCell>
                <THeadCell>Priority</THeadCell>
                <THeadCell>Active</THeadCell>
                <THeadCell className="pr-0">Actions</THeadCell>
              </tr>
            </THead>
            <tbody>
              {rules.map((rule) => (
                <TRow key={rule.id}>
                  <TCell className="font-medium text-foreground">{rule.name}</TCell>
                  <TCell className="text-foreground">{rule.source_model}</TCell>
                  <TCell>
                    <Badge tone="neutral">{rule.rule_type}</Badge>
                  </TCell>
                  <TCell className="text-muted-foreground">
                    {rule.target_model ?? rule.target_provider_id ?? "-"}
                  </TCell>
                  <TCell className="text-foreground">{rule.priority}</TCell>
                  <TCell>
                    <Form
                      id={`rule-toggle-${rule.id}`}
                      method="post"
                      className="hidden"
                    >
                      <input type="hidden" name="section" value="rules" />
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="id" value={rule.id} />
                    </Form>
                    <Toggle
                      checked={Boolean(rule.is_active)}
                      label={`${rule.is_active ? "Deactivate" : "Activate"} rule ${rule.name}`}
                      onChange={() => {
                        const form = document.getElementById(
                          `rule-toggle-${rule.id}`,
                        ) as HTMLFormElement | null;
                        form?.requestSubmit();
                      }}
                    />
                  </TCell>
                  <TCell className="pr-0">
                    <Form method="post">
                      <input type="hidden" name="section" value="rules" />
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={rule.id} />
                      <Button
                        type="submit"
                        variant="danger"
                        size="icon"
                        aria-label={`Delete rule ${rule.name}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </Form>
                  </TCell>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function AllowlistForm({ modelSuggestions }: { modelSuggestions: string[] }) {
  const [model, setModel] = useState("");
  return (
    <Form method="post" className="mb-4 flex flex-wrap items-end gap-3">
      <input type="hidden" name="section" value="allowlist" />
      <div>
        <Label htmlFor="allowlist-model">Model</Label>
        <Combobox
          id="allowlist-model"
          name="model_name"
          value={model}
          onChange={setModel}
          options={modelSuggestions}
          required
          placeholder="e.g. gpt-4o"
          className={comboboxClass}
        />
      </div>
      <div>
        <Label htmlFor="allowlist-action">Action</Label>
        <Select id="allowlist-action" name="action">
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </Select>
      </div>
      <div>
        <Label htmlFor="allowlist-reason">Reason</Label>
        <Input
          id="allowlist-reason"
          name="reason"
          autoComplete="off"
          className="w-64"
        />
      </div>
      <Button type="submit">Add</Button>
    </Form>
  );
}

function RulesForm({
  modelSuggestions,
  providerSuggestions,
}: {
  modelSuggestions: string[];
  providerSuggestions: string[];
}) {
  const [ruleType, setRuleType] = useState("rewrite");
  const [sourceModel, setSourceModel] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [targetProvider, setTargetProvider] = useState("");

  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">
        Routing rules are evaluated per request for the requested source model, in priority
        order:
        <span className="mt-1 block">
          <code>rewrite</code> — replace the requested model with <code>target model</code>
          {" · "}
          <code>deny</code> — block the model
          {" · "}
          <code>fallback</code> — reroute to <code>target provider</code> when the primary
          route fails
        </span>
      </p>
      <Form method="post" className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
        <input type="hidden" name="section" value="rules" />
        <div>
          <Label htmlFor="rule-name">Name</Label>
          <Input id="rule-name" name="name" required autoComplete="off" />
        </div>
        <div>
          <Label htmlFor="rule-source-model">Source Model</Label>
          <Combobox
            id="rule-source-model"
            name="source_model"
            value={sourceModel}
            onChange={setSourceModel}
            options={modelSuggestions}
            required
            placeholder="e.g. gpt-4o"
            className={comboboxClass}
          />
        </div>
        <div>
          <Label htmlFor="rule-type">Type</Label>
          <Select
            id="rule-type"
            name="rule_type"
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value)}
          >
            <option value="rewrite">rewrite</option>
            <option value="deny">deny</option>
            <option value="fallback">fallback</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="rule-priority">Priority</Label>
          <Input
            id="rule-priority"
            name="priority"
            type="number"
            defaultValue={0}
            autoComplete="off"
          />
        </div>
        {ruleType === "rewrite" ? (
          <div>
            <Label htmlFor="rule-target-model">Target Model</Label>
            <Combobox
              id="rule-target-model"
              name="target_model"
              value={targetModel}
              onChange={setTargetModel}
              options={modelSuggestions}
              placeholder="e.g. gpt-4o-mini"
              className={comboboxClass}
            />
          </div>
        ) : null}
        {ruleType === "fallback" ? (
          <div>
            <Label htmlFor="rule-target-provider">Target Provider</Label>
            <Combobox
              id="rule-target-provider"
              name="target_provider_id"
              value={targetProvider}
              onChange={setTargetProvider}
              options={providerSuggestions}
              placeholder="e.g. openai"
              className={comboboxClass}
            />
          </div>
        ) : null}
        <Button type="submit">Add</Button>
      </Form>
    </>
  );
}