'use strict';

const config = require('./config');

const path = require('path');

const _        = require('lodash');
const mkdirp   = require('mkdirp-promise');
const moment   = require('moment');
const NodeGit  = require('nodegit');
const octonode = require('octonode');
const rimraf   = require('rimraf-promise');
const winston  = require('winston');

const githubClient = octonode.client({
  username: config.get('github.username'),
  password: config.get('github.password'),
});

const READ_PATH  = path.join(config.get('github.localPath'), 'r');
const WRITE_PATH = path.join(config.get('github.localPath'), 'w');

const createEmptyGrid = function createEmptyGrid() {
  // FIXME: Ignore the incomplete weeks, so the world can wrap.
  const columnCount = Math.ceil(365 / 7);

  const grid = [];

  while (grid.length < columnCount) {
    grid.push([]);
  }

  return grid;
};

const forEachNode = function forEachNode(grid, eachFn) {
  for (let x = 0; x < grid.length; x++) {
    for (let y = 0; y < 7; y++) {
      eachFn(grid[x][y], x, y);
    }
  }
};

const getRepoInfo = function getRepoInfo() {
  const repo = githubClient.repo(config.get('github.repo'));

  return new Promise(function promiseToGetRepoInfo(resolve, reject) {
    repo.info(function handleResponse(err, data) {
      if (err) {
        return reject(err);
      }

      resolve(data);
    });
  });
};

const cloneRepo = function cloneRepo(repoInfo) {
  return rimraf(READ_PATH)
    .then(function clone() {
      return NodeGit.Clone.clone(
        repoInfo.clone_url,
        READ_PATH,
        {
          checkoutBranch: config.get('github.branch'),
        }
      );
    });
};

const createRepo = function createRepo(repoInfo) {
  return rimraf(WRITE_PATH)
    .then(function createDir() {
      return mkdirp(WRITE_PATH);
    })
    .then(function initRepo() {
      return NodeGit.Repository.init(WRITE_PATH, 0);
    })
    .then(function addRemote(repository) {
      return Promise.all([
        Promise.resolve(repository),
        NodeGit.Remote.create(repository, 'origin', repoInfo.clone_url),
      ]);
    })
    .then(function resolveRepository(results) {
      const repository = results[0];

      return Promise.resolve(repository);
    });
};

const stepLife = function stepLife(repository) {
  return repository.getBranchCommit(config.get('github.branch'))
    .then(function getCommits(firstCommit) {
      const commits = [];

      const history = firstCommit.history(NodeGit.Revwalk.SORT.Time);

      return new Promise(function promiseToGetCommits(resolve, reject) {
        history.on('commit', function getCommit(commit) {
          commits.push(commit);
        });

        history.on('error', reject);

        history.on('end', function resolveCommits() {
          resolve(commits);
        });

        history.start();
      });
    })
    .then(function countCommits(commits) {
      const counts = {};

      commits.forEach(function incrementCount(commit) {
        const date = commit.date();

        if (date.getTime() === 0) {
          return;
        }

        date.setUTCHours(0, 0, 0, 0);

        const dateString = date.toJSON();

        if (!counts[dateString]) {
          counts[dateString] = 0;
        }

        counts[dateString]++;
      });

      return Promise.resolve(counts);
    })
    .then(function createGrid(counts) {
      const grid = createEmptyGrid();

      const now = moment.utc();

      now.hours(0, 0, 0, 0);

      const lastRowIndex = now.day();

      _.each(counts, function addToGrid(count, dateString) {
        const days  = now.diff(dateString, 'days');
        const weeks = now.diff(dateString, 'weeks');

        const rowIndex = ((lastRowIndex - days) % 7 + 7) % 7;

        grid[grid.length - 1 - weeks][rowIndex] = count;
      });

      return Promise.resolve(grid);
    })
    .then(function stepGrid(grid) {
      const newGrid     = createEmptyGrid();
      const columnCount = newGrid.length;

      // TODO: Fade out the grid nodes instead of stepping them. Leave a trail?
      forEachNode(grid, function updateNewGrid(node, x, y) {
        let alive = false;

        if (node > 0) {
          alive = true;
        }

        let aliveNeighbours = 0;

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const nx = ((x + dx) % columnCount + columnCount) % columnCount;
            const ny = ((y + dy) % 7 + 7) % 7;

            if (grid[nx][ny] > 0) {
              aliveNeighbours++;
            }
          }
        }

        if (alive) {
          if (aliveNeighbours < 2 || aliveNeighbours > 3) {
            alive = false;
          }
        } else if (aliveNeighbours > 3) {
          alive = true;
        }

        if (alive) {
          newGrid[x][y] = 1;
        }
      });

      return Promise.resolve(newGrid);
    });
};

getRepoInfo()
  .then(function setupRepos(info) {
    return Promise.all([
      createRepo(info)
        .then(function getTree(repository) {
          return Promise.all([
            Promise.resolve(repository),
            repository.openIndex()
              .then(function writeTree(index) {
                return index.writeTree();
              }),
          ]);
        }),
      cloneRepo(info)
        .then(stepLife),
    ]);
  })
  .then(function makeCommits(results) {
    const repository = results[0][0];
    const tree       = results[0][1];
    const grid       = results[1];

    const name    = config.get('commit.name');
    const email   = config.get('commit.email');
    const message = config.get('commit.message');

    const sigs = [];

    forEachNode(grid, function createSig(node, x, y) {
      if (!node) {
        return;
      }

      // FIXME: Use x and y to specify the date.
      const date = new Date();

      const sig = NodeGit.Signature.create(
        name, email, Math.round(date.getTime() / 1000), 0
      );

      sigs.push(sig);
    });

    const initialSig = NodeGit.Signature.create(name, email, 0, 0);

    return Promise.all([
      Promise.resolve(repository),
      repository.createCommit(
        'HEAD', initialSig, initialSig, 'Initial commit', tree, []
      )
        .then(function executeCommits() {
          return Promise.all(sigs.map(function commit(sig) {
            // FIXME: This needs to wait for the previous commit,
            //        and pass it in as the parent. Or use createCommitOnHead?
            return repository.createCommit('HEAD', sig, sig, message, tree, []);
          }));
        }),
    ]);
  })
  // TODO: Then create commits for any new issues (and close them).
  .then(function pushChanges(results) {
    const repository = results[0];
    // const commits    = results[1];

    return repository.getRemote('origin')
      .then(function push(remote) {
        return remote.push(
          [
            `+refs/heads/master:refs/heads/${config.get('github.branch')}`,
          ],
          {
            callbacks: {
              credentials: function credentials() {
                return NodeGit.Cred.userpassPlaintextNew(
                  config.get('github.username'), config.get('github.password')
                );
              },
            },
          }
        );
      });
  })
  .catch(function onReject(err) {
    winston.error(err);
  });
