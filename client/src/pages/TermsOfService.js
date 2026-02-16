import React from "react";
import { Link } from "react-router-dom";

const TermsOfService = () => {
  return (
    <div className="auth-page">
      <div className="auth-card" style={{ maxWidth: 800 }}>
        <div className="brand">
          <span>Unified Inbox</span>
        </div>
        <h1>Terms of Service</h1>

        <div style={{ textAlign: "left", marginTop: 20, lineHeight: 1.6 }}>
          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            1. Acceptance of Terms
          </h2>
          <p>
            By accessing and using Unified Inbox, you accept and agree to be
            bound by the terms and provision of this agreement.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>2. Use License</h2>
          <p>
            Permission is granted to temporarily use Unified Inbox for personal
            or commercial purposes. This is the grant of a license, not a
            transfer of title.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>3. User Account</h2>
          <p>
            You are responsible for maintaining the confidentiality of your
            account and password. You agree to accept responsibility for all
            activities that occur under your account.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>4. Prohibited Uses</h2>
          <p>
            You may not use Unified Inbox for any illegal or unauthorized
            purpose. You must not transmit any worms, viruses, or any code of a
            destructive nature.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            5. Service Modifications
          </h2>
          <p>
            We reserve the right to modify or discontinue the service at any
            time without notice. We shall not be liable to you or any third
            party for any modification or discontinuation.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            6. Limitation of Liability
          </h2>
          <p>
            Unified Inbox shall not be liable for any indirect, incidental,
            special, consequential, or punitive damages resulting from your
            access to or use of the service.
          </p>

          <h2 style={{ fontSize: 18, marginTop: 20 }}>
            7. Contact Information
          </h2>
          <p>
            If you have any questions about these Terms of Service, please
            contact us at support@unifiedinbox.com
          </p>

          <p style={{ marginTop: 30, fontSize: 12, color: "#666" }}>
            Last updated: February 16, 2026
          </p>
        </div>

        <div style={{ marginTop: 30 }}>
          <Link
            to="/login"
            className="btn-primary"
            style={{ display: "inline-block", textDecoration: "none" }}
          >
            Back to Login
          </Link>
        </div>
      </div>
    </div>
  );
};

export default TermsOfService;
