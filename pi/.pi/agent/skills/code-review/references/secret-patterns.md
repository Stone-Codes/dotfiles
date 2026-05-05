# Secret Detection Patterns

## High-Confidence Patterns

These patterns should ALWAYS be flagged as they are almost certainly secrets:

```
# API Keys (generic)
[a-zA-Z0-9]{32,}

# AWS
AKIA[0-9A-Z]{16}
aws_secret_access_key[ =:]+[a-zA-Z0-9/+=]{40}

# GitHub
ghp_[a-zA-Z0-9]{36}
github_pat_[a-zA-Z0-9_]{82}
ghs_[a-zA-Z0-9]{36}

# GitLab
glpat-[a-zA-Z0-9_]{20}

# Stripe
sk_live_[0-9a-zA-Z]{24,}
pk_live_[0-9a-zA-Z]{24,}

# Private Keys
-----BEGIN [A-Z]+ PRIVATE KEY-----

# Google Service Account
"type": "service_account"
"private_key": "[^"]+"

# JWT (if not in test file)
eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
```

## Medium-Confidence Patterns

Flag if context suggests production use (not test/mock):

```
# Generic passwords/tokens in config
password\s*=\s*['"][^'"]{8,}['"]
token\s*=\s*['"][^'"]{16,}['"]
api_key\s*=\s*['"][^'"]{16,}['"]
secret\s*=\s*['"][^'"]{16,}['"]

# Database connection strings
mongodb(\+srv)?://[^:]+:[^@]+@
postgres://[^:]+:[^@]+@
mysql://[^:]+:[^@]+@
```

## False Positive Exclusions

Do NOT flag these:

```
# Test/mock values
"test_"
"mock_"
"fake_"
"dummy_"
"example_"
"<API_KEY>"
"your-api-key-here"
"replace-with-"

# Environment variable references (not values)
process.env.SECRET
os.environ['SECRET']

# Placeholder patterns
\[REDACTED\]
\*\*\*\*\*
XXXXXX
XXXX-XXXX

# Documentation examples
// In README.md, docs/, *.md files
# In code comments (//, /*, #, <!--)
```

## Verification Steps

Before flagging a secret:

1. Check if file is a test file (`*.test.js`, `*.spec.ts`, `*_test.py`, `test_*`)
2. Check if in mock/fixture directory (`__mocks__`, `fixtures`, `test`)
3. Read surrounding context (is it a comment or documentation?)
4. Check if it's a placeholder (contains "example", "test", "mock")
5. Verify it's on a line modified by the PR (not pre-existing)

## Confidence Scoring for Secrets

| Scenario | Confidence |
|----------|------------|
| Real AWS/GitHub/Stripe key in production code | 100% |
| API key pattern in config file (not test) | 90% |
| Password in plain text config (not test) | 85% |
| Generic token pattern, unclear context | 60% |
| In test file or mock | 0% |
| Clearly a placeholder | 0% |
