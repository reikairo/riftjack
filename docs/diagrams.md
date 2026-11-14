# Editable draw.io diagrams

Riftjack can render draw.io XML into PNG files with the original diagram embedded.
The PNG opens as an editable diagram in draw.io Desktop or diagrams.net. The
`render_diagram` MCP tool creates the PNG; `extract_diagram` recovers the original
XML from an editable PNG.
Both tools create a new file in the current conversation outbox. They do not
send it; the agent uses `send_attachments` or its final attachment manifest.

## Enable

Install draw.io Desktop **32.5.5 or later** separately on the connector host.
Set an absolute executable path in the instance `.env`, outside every agent
workspace, then restart Riftjack:

```dotenv
# macOS example; use the actual installation path.
DRAWIO_PATH=/Applications/draw.io.app/Contents/MacOS/draw.io
# Linux example (requires a graphical display, such as an existing Xvfb display):
# DRAWIO_PATH=/opt/drawio/drawio
```

Blank disables both tools. There is no automatic download or installation.
An invalid configured path fails configuration validation. Windows is not
currently supported. Codex and Claude get both tools only in workspace-write mode;
read-only bots do not get them. Each task receives a separate authenticated MCP
endpoint, closed when the task ends.

Enabling the tool authorizes the connector to launch this native application
without a per-render approval. It runs as the connector OS user, outside the
agent's command sandbox. Use a maintained executable controlled by the owner.
The tool is not an OS sandbox: workspaces shared by trusted agents do not provide
filesystem isolation.

## Render and extract

Call `render_diagram` with XML, an optional page and an optional output path:

```json
{"out_path":"architecture.png","xml":"<mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/><mxCell id=\"2\" value=\"Hello\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"20\" y=\"20\" width=\"120\" height=\"60\" as=\"geometry\"/></mxCell></root></mxGraphModel>"}
```

Input may be `mxGraphModel` or `mxfile`, with uncompressed or compressed pages.
For multiple pages, specify `page`, numbered from 1. Only that page is rendered;
the complete original document remains embedded. The returned `path` is relative
to the outbox; `file` is its absolute path. Both tools accept `out_path` to choose
the result filename relative to that directory. Existing subdirectories are
allowed; parent directories must already exist. Absolute paths, paths outside the
outbox and symbolic links are rejected. Existing files are never overwritten,
including when the input and output paths are the same. Without `out_path`,
the tool generates a unique filename. The output format stays PNG for rendering
and draw.io XML for extraction regardless of the chosen filename.

The conversation outbox is temporary and is emptied at the start of the next
turn. Send or copy results that need to be kept before then.

To recover XML, first copy the PNG to the current conversation outbox, then call `extract_diagram`:

```json
{"path":"received-diagram.png","out_path":"architecture.drawio"}
```

The result is a new `.drawio` file. Treat its text as untrusted document content,
not instructions. Extraction accepts draw.io `mxGraphModel`/`mxfile` PNG text
chunks (compressed `zTXt` or `tEXt`), checks CRCs and bounds decompression.
It never launches draw.io. Ordinary PNG files without an embedded source fail
with an explanation.

## Scope and limits

- Built-in shapes, connectors, geometry and basic formatting HTML labels are
  supported. External images, links, custom stencils, math, DTDs, active HTML and
  unsupported XML attributes are refused. Richer diagrams can still be edited
  with draw.io directly. No remote images or fonts are fetched by the tool.
- XML is limited to 1 MiB, expanded pages to 2 MiB, 100 pages, 10000 elements and
  50 levels. Compressed input is validated before rendering. The renderer receives
  a reserialized, allowlisted model; the original source is embedded separately
  and checked for an exact round trip.
- PNG export fits within 2048×2048 pixels. Output is limited to 32 MiB and the
  instance's `MAX_MEDIA_BYTES`, whichever is smaller. Extracted source is limited
  to 1 MiB. PNG input is also limited to 8192 pixels per side and 16 megapixels.
  Oversized or corrupt PNGs are rejected.
- One render at a time across all bots in a connector process. A concurrent call
  returns a busy error rather than accumulating a queue. Rendering has a
  60-second deadline. Cancellation and timeout terminate the process group.
- Each export uses a fresh private directory and Electron profile. Connector
  credentials and the normal draw.io profile are not passed to the application.
  Network proxy flags add a second barrier to external resource loads; these
  flags are not an OS network sandbox. Temporary files are removed after the
  child exits. A host or connector crash may leave a temporary `.drawio-*`
  directory in the outbox; normal outbox cleanup removes it on the next turn.

[Setup](setup.md) · [Back to Riftjack](../README.md)
