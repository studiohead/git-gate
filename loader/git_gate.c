/*
 * git_gate.c — Git Gate enforcement engine
 *
 * Checks whether any file path passed to `git add` matches the
 * sensitive-file rules defined in git-gate-config.json.
 *
 * Build:
 *   gcc -O2 -o git_gate git_gate.c
 *
 * Usage (called by the Python loader or directly):
 *   ./git_gate <config.json> <file1> [file2 ...]
 *
 * Exit codes:
 *   0  – all files are safe to stage
 *   1  – one or more files are blocked (names printed to stderr)
 *   2  – usage / config error
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>

/* ── tunables ─────────────────────────────────────────────────────────── */
#define MAX_RULES      256
#define MAX_PATH_LEN   4096
#define MAX_FILE_SIZE  (1 << 20)   /* 1 MiB – config sanity cap */

/* ── tiny JSON rule extractor ─────────────────────────────────────────── */
typedef struct {
    char *rules[MAX_RULES];
    int   count;
} RuleSet;

static char *read_file(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) { perror(path); return NULL; }

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);

    if (sz <= 0 || sz > MAX_FILE_SIZE) {
        fprintf(stderr, "git-gate: config file size invalid (%ld bytes)\n", sz);
        fclose(f);
        return NULL;
    }

    char *buf = malloc(sz + 1);
    if (!buf) { fclose(f); return NULL; }

    fread(buf, 1, sz, f);
    buf[sz] = '\0';
    fclose(f);
    return buf;
}

static const char *skip_string(const char *p, char *out, size_t cap) {
    if (*p != '"') return NULL;
    p++;
    size_t i = 0;
    while (*p && *p != '"') {
        if (*p == '\\') { p++; if (!*p) break; }
        if (i + 1 < cap) out[i++] = *p;
        p++;
    }
    out[i] = '\0';
    if (*p == '"') p++;
    return p;
}

static int parse_rules(const char *json, RuleSet *rs) {
    rs->count = 0;

    const char *key = strstr(json, "\"sensitiveFiles\"");
    if (!key) {
        fprintf(stderr, "git-gate: 'sensitiveFiles' key not found in config\n");
        return -1;
    }
    key += strlen("\"sensitiveFiles\"");

    while (*key && (isspace((unsigned char)*key) || *key == ':')) key++;

    if (*key != '[') {
        fprintf(stderr, "git-gate: expected '[' after sensitiveFiles\n");
        return -1;
    }
    key++;

    char tmp[MAX_PATH_LEN];
    while (*key) {
        while (*key && isspace((unsigned char)*key)) key++;
        if (*key == ']') break;
        if (*key == '"') {
            const char *after = skip_string(key, tmp, sizeof(tmp));
            if (!after) break;
            key = after;
            if (rs->count < MAX_RULES) {
                rs->rules[rs->count] = strdup(tmp);
                if (rs->rules[rs->count]) rs->count++;
            }
        } else if (*key == ',') {
            key++;
        } else {
            key++;
        }
    }
    return 0;
}

static void free_rules(RuleSet *rs) {
    for (int i = 0; i < rs->count; i++) free(rs->rules[i]);
    rs->count = 0;
}

/* ── matching logic ───────────────────────────────────────────────────── */

/*
 * Glob matching:
 *   *  → any sequence of non-'/' chars
 *   ** → any sequence including '/'
 *   ?  → any single non-'/' char
 *
 * Rule semantics:
 *   - Trailing '/'  → match any path component equal to the dir name
 *   - Contains '/'  → full path glob match
 *   - Plain name    → basename match only
 */

static int glob_match(const char *p, const char *s) {
    while (*p) {
        if (p[0] == '*' && p[1] == '*') {
            p += 2;
            if (*p == '/') p++;
            if (!*p) return 1;
            do {
                if (glob_match(p, s)) return 1;
            } while (*s++);
            return 0;
        } else if (*p == '*') {
            p++;
            do {
                if (glob_match(p, s)) return 1;
            } while (*s && *s != '/' && s++);
            return 0;
        } else if (*p == '?') {
            if (!*s || *s == '/') return 0;
            p++; s++;
        } else {
            if (*p != *s) return 0;
            p++; s++;
        }
    }
    return *s == '\0';
}

static const char *basename_of(const char *path) {
    const char *b = strrchr(path, '/');
    return b ? b + 1 : path;
}

/*
 * Match a plain name rule against every component in the filepath.
 * e.g. rule ".claude" blocks ".claude", ".claude/config", "a/.claude/b".
 */
static int component_match(const char *filepath, const char *rule) {
    char fp[MAX_PATH_LEN];
    strncpy(fp, filepath, sizeof(fp) - 1);
    fp[MAX_PATH_LEN - 1] = '\0';

    char *seg = strtok(fp, "/");
    while (seg) {
        if (glob_match(rule, seg)) return 1;
        seg = strtok(NULL, "/");
    }
    return 0;
}

static int is_blocked_by(const char *filepath, const char *rule) {
    size_t rlen = strlen(rule);

    /* Explicit directory rule (trailing '/') — match any path component */
    if (rlen > 0 && rule[rlen - 1] == '/') {
        char dir[MAX_PATH_LEN];
        strncpy(dir, rule, sizeof(dir) - 1);
        dir[rlen - 1] = '\0';
        return component_match(filepath, dir);
    }

    /* Path-qualified rule (contains '/') — full path glob match */
    if (strchr(rule, '/')) {
        return glob_match(rule, filepath);
    }

    /*
     * Plain name rule — match against every path component.
     * This blocks both the file itself and any file nested inside a
     * directory with that name.
     * e.g. ".env-example" blocks "src/.env-example"
     *      ".claude"      blocks ".claude/settings.json"
     */
    return component_match(filepath, rule);
}

/* ── main ─────────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr,
            "usage: git_gate <config.json> <file> [file ...]\n"
            "  Exits 0 if all files are safe, 1 if any are blocked.\n");
        return 2;
    }

    const char *config_path = argv[1];

    char *json = read_file(config_path);
    if (!json) return 2;

    RuleSet rs;
    if (parse_rules(json, &rs) < 0) {
        free(json);
        return 2;
    }
    free(json);

    if (rs.count == 0) {
        free_rules(&rs);
        return 0;
    }

    int blocked = 0;
    for (int i = 2; i < argc; i++) {
        const char *fp = argv[i];
        for (int r = 0; r < rs.count; r++) {
            if (is_blocked_by(fp, rs.rules[r])) {
                fprintf(stderr,
                    "git-gate: BLOCKED \xe2\x80\x94 '%s' matches rule '%s'\n",
                    fp, rs.rules[r]);
                blocked = 1;
                break;
            }
        }
    }

    free_rules(&rs);

    if (blocked) {
        fprintf(stderr,
            "git-gate: Staging aborted. "
            "Edit git-gate-config.json to change rules.\n");
        return 1;
    }
    return 0;
}
