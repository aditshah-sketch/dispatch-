# DNS records for sending The Dispatch from pg27.mesaschool.co (Resend)

Add these in the Cloudflare DNS zone for `mesaschool.co`, then press **Verify** in Resend → Domains.
They only add a separate sending subdomain (`send.pg27`) and a DKIM key. The existing Google Workspace mail is unaffected: the MX for `pg27` stays `smtp.google.com`.

| Type | Name (in zone mesaschool.co) | Value | Priority |
|---|---|---|---|
| TXT | `resend._domainkey.pg27` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC+/89ZnMuDi8k8E+8KLLNaCxnTto5VsyTOsgaiAESI1FOeLTR2sKTzCvQx4v8TXXWnt+jZsbXTpFfyQXj1J3z3jdXq7CdnAmdko4jl2ot/iNgzI7NbF8EeGVVOZiHPGYwAVixxqGpiXwItPmy4iVDmtag3ZKxByqzoMc+mXLphvwIDAQAB` |  |
| MX | `send.pg27` | `feedback-smtp.us-east-1.amazonses.com` | 10 |
| TXT | `send.pg27` | `v=spf1 include:amazonses.com ~all` |  |
| CNAME | `rsend.pg27` | `send.forge.rmta.net` |  |

Status in Resend when added (2026-10-12): not_started
