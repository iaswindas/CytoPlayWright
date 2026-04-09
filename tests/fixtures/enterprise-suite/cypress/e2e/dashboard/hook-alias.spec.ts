describe("Hook alias hoisting", function () {
  beforeEach(function () {
    cy.visit("/dashboard/profile");
    cy.fixture("user.json").as("userData");
    cy.get("[data-testid='primary-link']").as("primaryLink");
  });

  it("rewrites hook aliases into describe scoped bindings", function () {
    // Preserve this comment during conversion.
    cy.get("@userData").then(() => {
      cy.get("[data-testid='username']").type(this.userData.username);
    });

    cy.get("@primaryLink").then(($link) => {
      expect($link.attr("href")).to.eq("/dashboard");
      expect($link.hasClass("active")).to.eq(true);
      expect($link.text()).to.eq("Dashboard");
    });
  });
});
