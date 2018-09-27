require("dotenv").config();

const fetch = require("node-fetch");
global.fetch = fetch;

const { default: ApolloClient } = require("apollo-client");
const { createHttpLink } = require("apollo-link-http");
const { setContext } = require("apollo-link-context");
const { InMemoryCache } = require("apollo-cache-inmemory");
const { default: gql } = require("graphql-tag");
const _ = require("lodash");

const githubToken = process.env.GITHUB_TOKEN;
const zenhubToken = process.env.ZENHUB_TOKEN;
const masterOwner = process.env.GITHUB_MASTER_OWNER;
const masterRepo = process.env.GITHUB_MASTER_REPO;
const currentMilestone = process.env.ZENHUB_CURRENT_MILESTONE;

console.debug({
  githubToken,
  zenhubToken,
  masterOwner,
  masterRepo,
  currentMilestone
});

const httpLink = createHttpLink({
  uri: "https://api.github.com/graphql"
});

const authLink = setContext((_, { headers }) => {
  // return the headers to the context so httpLink can read them
  return {
    headers: {
      ...headers,
      authorization: githubToken ? `Bearer ${githubToken}` : ""
    }
  };
});

const client = new ApolloClient({
  link: authLink.concat(httpLink),
  cache: new InMemoryCache()
});

const getMasterDatabaseId = async () => {
  const getMainRepoId = gql`
    query masterRepo($name: String!, $owner: String!) {
      repository(name: $name, owner: $owner) {
        databaseId
      }
    }
  `;

  const masterRepoDetails = await client.query({
    query: getMainRepoId,
    variables: {
      name: masterRepo,
      owner: masterOwner
    }
  });

  const masterDatabaseId = masterRepoDetails.data.repository.databaseId;
  return masterDatabaseId;
};

const getZenhubWorkspace = async masterDatabaseId => {
  const res = await fetch(
    `https://api.zenhub.io/v4/repos/${masterDatabaseId}/workspace`,
    {
      headers: {
        "X-Authentication-Token": zenhubToken,
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
  const workspace = await res.json();

  // console.log(workspace);
  return workspace;
};

const getZenhubBoard = async masterDatabaseId => {
  const res = await fetch(
    `https://api.zenhub.io/v3/repos/${masterDatabaseId}/board`,
    {
      headers: {
        "X-Authentication-Token": zenhubToken,
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
  const board = await res.json();
  return board;
};

const getZenhubIssues = async repoId => {
  const res = await fetch(
    `https://api.zenhub.io/v5/repositories/${repoId}/issues?epics=1&estimates=1&connections=1&dependencies=1`,
    {
      headers: {
        "X-Authentication-Token": zenhubToken,
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );

  return await res.json();
};

const getAllZenhubIssues = async workspace => {
  const allIssuePromises = [];
  for (let i = 0; i < workspace.repos.length; i++) {
    const repoDetails = workspace.repos[i];
    allIssuePromises.push(getZenhubIssues(repoDetails.repo_id));
  }

  const allResults = await Promise.all(allIssuePromises);

  const allIssues = _.flatten(allResults);
  return allIssues;
};

async function main() {
  const masterDatabaseId = await getMasterDatabaseId();

  const workspace = await getZenhubWorkspace(masterDatabaseId);

  const board = await getZenhubBoard(masterDatabaseId);

  const issues = await getAllZenhubIssues(workspace);

  const repoIssuePipelineMap = {};

  const richPipelines = board.pipelines.map(
    ({ name, issues: pipelineIssues }, idx) => {
      pipelineIssues.map(({ repo_id, issue_number }) => {
        repoIssuePipelineMap[`${repo_id}.${issue_number}`] = idx;
      });
      return { name, issues: [] };
    }
  );

  richPipelines.push({
    name: "Closed",
    issues: []
  });

  issues.map(issue => {
    const pipelineIndex =
      repoIssuePipelineMap[`${issue.repo_id}.${issue.number}`];

    if (issue.pull_request) {
      return;
    }

    if (pipelineIndex !== undefined && issue.state !== "closed") {
      richPipelines[pipelineIndex].issues.push(issue);
    } else {
      richPipelines[richPipelines.length - 1].issues.push(issue);
    }
  });

  const stats = {
    open: 0,
    closed: 0
  };

  richPipelines.map(({ name, issues }) => {
    const milestoneIssues = _.filter(issues, issue => {
      return issue.milestone && issue.milestone.title === currentMilestone;
    });

    const totalPoints = _.sumBy(milestoneIssues, "estimate");

    if (name === "Done" || name === "Closed") {
      stats.closed = stats.closed + totalPoints;
    } else {
      stats.open = stats.open + totalPoints;
    }

    const sectionTitle = `${name} - ${totalPoints} Points`;
    console.log(sectionTitle);
    console.log(_.repeat("-", sectionTitle.length));
    if (milestoneIssues.length === 0) {
      console.log("None");
    } else {
      milestoneIssues.map(
        ({ repo_name, number, title, estimate, assignee, html_url }) => {
          let assigneeString = "";
          if (assignee) {
            assigneeString = ` ${assignee.login}`;
          }
          console.log(
            `${repo_name}#${number}: ${title} [${estimate} pts]${assigneeString}`
          );
          console.log(html_url);
        }
      );
    }
    console.log(" ");
  });

  console.log(`Total: ${stats.open} / ${stats.closed + stats.open}`);
}

main();
