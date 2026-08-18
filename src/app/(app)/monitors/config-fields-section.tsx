"use client";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ConfigField } from "@/modules/monitors/types/contract";

import { isFieldVisible, type ConfigFieldState } from "./config-fields";

/**
 * What a select's "not set" option carries inside the control.
 *
 * Radix treats `""` as "no value" and throws if an item uses it, so the
 * empty option needs a stand-in. It never reaches form state, let alone
 * the server: the change handler maps it straight back to `""`, which
 * `buildConfig` turns into `null` or an omission.
 */
const NOT_SET = "__vigil_not_set__";

/**
 * The controls a check type declares for its own settings.
 *
 * Generic on purpose. The dialog used to carry hand-written JSX for four
 * types and nothing for the other twenty-four, so a type could ship with
 * settings no operator could reach — a JSON-query monitor checking a
 * path nobody chose, a Redis monitor with no password box that reads
 * green against a server it never authenticated to. Rendering from the
 * declaration means the form cannot fall behind the registry, and the
 * conformance suite compares the two.
 */
export function ConfigFieldsSection({
  idPrefix,
  fields,
  state,
  onChange,
}: {
  idPrefix: string;
  fields: readonly ConfigField[];
  state: ConfigFieldState;
  onChange: (name: string, value: string | boolean) => void;
}) {
  const visible = fields.filter((field) => isFieldVisible(field, state));
  if (visible.length === 0) return null;

  return (
    <div className="grid grid-cols-2 gap-4">
      {visible.map((field) => {
        const fieldId = `${idPrefix}-cfg-${field.name}`;
        const value = state[field.name];
        const control = field.control;

        return (
          <Field
            key={field.name}
            // A select of protocols and a free-text OID do not want the
            // same width, but a two-column grid with one long help line
            // reads worse than a full-width row. Text and secret take
            // the row; the compact controls share one.
            className={
              control.kind === "text" || control.kind === "secret"
                ? "col-span-2"
                : undefined
            }
          >
            <FieldLabel htmlFor={fieldId}>{field.label}</FieldLabel>

            {control.kind === "select" ? (
              <Select
                value={
                  typeof value === "string" && value !== "" ? value : NOT_SET
                }
                onValueChange={(next) =>
                  onChange(field.name, next === NOT_SET ? "" : next)
                }
              >
                <SelectTrigger id={fieldId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {control.options.map((option) => (
                    <SelectItem
                      key={option.value}
                      // Radix refuses "" as an item value, so the "not
                      // set" option carries a sentinel and is mapped
                      // back on the way out.
                      value={option.value === "" ? NOT_SET : option.value}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : control.kind === "boolean" ? (
              <Select
                value={value === true ? "yes" : "no"}
                onValueChange={(next) => onChange(field.name, next === "yes")}
              >
                <SelectTrigger id={fieldId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes">Yes</SelectItem>
                  <SelectItem value="no">No</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={fieldId}
                // A secret is a password input so it is not shoulder-read
                // and not offered to a password manager as a login.
                type={
                  control.kind === "secret"
                    ? "password"
                    : control.kind === "number"
                      ? "number"
                      : "text"
                }
                autoComplete={control.kind === "secret" ? "off" : undefined}
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(field.name, event.target.value)}
                placeholder={
                  control.kind === "number" ? undefined : control.placeholder
                }
                maxLength={
                  control.kind === "text" || control.kind === "secret"
                    ? control.maxLength
                    : undefined
                }
                min={control.kind === "number" ? control.min : undefined}
                max={control.kind === "number" ? control.max : undefined}
                step={control.kind === "number" ? control.step : undefined}
                className={
                  (control.kind === "text" && control.mono) ||
                  control.kind === "secret"
                    ? "font-mono"
                    : undefined
                }
              />
            )}

            {field.help && <FieldDescription>{field.help}</FieldDescription>}
          </Field>
        );
      })}
    </div>
  );
}
