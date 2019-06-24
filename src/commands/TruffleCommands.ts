// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as bip39 from 'bip39';
import * as fs from 'fs-extra';
// @ts-ignore
import * as hdkey from 'hdkey';
import * as path from 'path';
import { format } from 'url';
import { ProgressLocation, QuickPickItem, Uri, window } from 'vscode';
import { Constants } from '../Constants';
import { GanacheService } from '../GanacheService/GanacheService';
import {
  getWorkspaceRoot,
  outputCommandHelper,
  required,
  showConfirmPaidOperationDialog,
  showQuickPick,
  TruffleConfig,
  TruffleConfiguration,
  vscodeEnvironment,
} from '../helpers';
import { MnemonicRepository } from '../MnemonicService/MnemonicRepository';
import {
  Consortium,
  LocalNetworkConsortium,
  MainNetworkConsortium,
} from '../Models';
import { Output } from '../Output';
import { ConsortiumTreeManager } from '../treeService/ConsortiumTreeManager';
import { ConsortiumCommands } from './ConsortiumCommands';

interface IDeployDestination {
  cmd: () => Promise<void>;
  cwd?: string;
  description?: string;
  detail?: string;
  label: string;
  networkId: string | number;
  consortiumId?: number;
}

interface IExtendedQuickPickItem extends QuickPickItem {
  /**
   * Additional field for storing non-displayed information
   */
  extended: string;
}

const localGanacheRegexp = new RegExp(`127\.0\.0\.1\:${Constants.defaultLocalhostPort}`, 'g');

export namespace TruffleCommands {
  export async function buildContracts(): Promise<void> {
    await window.withProgress({
      location: ProgressLocation.Window,
      title: Constants.statusBarMessages.buildingContracts,
    }, async () => {
      if (!await required.checkAppsSilent(required.Apps.truffle)) {
        await required.installTruffle(required.Scope.locally);
      }

      try {
          Output.show();
          await outputCommandHelper.executeCommand(getWorkspaceRoot(), 'npx', 'truffle', 'compile');
        } catch (error) {
          throw Error(error);
        }
    });
  }

  export async function deployContracts(consortiumTreeManager: ConsortiumTreeManager): Promise<void> {
    if (!await required.checkAppsSilent(required.Apps.truffle)) {
      await required.installTruffle(required.Scope.locally);
    }

    const truffleConfigsUri = TruffleConfiguration.getTruffleConfigUri();
    const defaultDeployDestinations = getDefaultDeployDestinations(truffleConfigsUri, consortiumTreeManager);
    const truffleDeployDestinations = getTruffleDeployDestinations(truffleConfigsUri);
    const consortiumDeployDestinations = getConsortiumDeployDestinations(truffleConfigsUri, consortiumTreeManager);

    const deployDestinations: IDeployDestination[] = [];
    deployDestinations.push(...defaultDeployDestinations);
    deployDestinations.push(...truffleDeployDestinations);
    deployDestinations.push(...consortiumDeployDestinations);

    return execute(deployDestinations.filter((destination, index, self) => {
      if (!destination.consortiumId) {
        return true;
      }
      return self.findIndex((dest) => dest.consortiumId === destination.consortiumId) === index;
    }));
  }

  export async function writeAbiToBuffer(uri: Uri): Promise<void> {
    const contract = await readCompiledContract(uri);

    vscodeEnvironment.writeToClipboard(JSON.stringify(contract[Constants.contractProperties.abi]));
  }

  export async function writeBytecodeToBuffer(uri: Uri): Promise<void> {
    const contract = await readCompiledContract(uri);

    vscodeEnvironment.writeToClipboard(contract[Constants.contractProperties.bytecode]);
  }

  export async function acquireCompiledContractUri(uri: Uri): Promise<Uri> {
    if (path.extname(uri.fsPath) === Constants.contractExtension.json) {
      return uri;
    } else {
      throw new Error(Constants.errorMessageStrings.InvalidContract);
    }
  }

  export async function getPrivateKeyFromMnemonic(): Promise<void> {
    const mnemonicItems: IExtendedQuickPickItem[] = MnemonicRepository
      .getExistedMnemonicPaths()
      .map((mnemonicPath) => {
        const savedMnemonic = MnemonicRepository.getMnemonic(mnemonicPath);
        return {
          detail: mnemonicPath,
          extended: savedMnemonic,
          label: MnemonicRepository.MaskMnemonic(savedMnemonic),
        };
      });

    if (mnemonicItems.length === 0) {
      window.showErrorMessage(Constants.errorMessageStrings.ThereAreNoMnemonics);
      return;
    }

    const mnemonicItem = await showQuickPick(
      mnemonicItems,
      { placeHolder: Constants.placeholders.selectMnemonicExtractKey, ignoreFocusOut: true },
    );

    const mnemonic = mnemonicItem.extended;
    if (!mnemonic) {
      window.showErrorMessage(Constants.errorMessageStrings.MnemonicFileHaveNoText);
      return;
    }

    try {
      const buffer = await bip39.mnemonicToSeed(mnemonic);
      const key = hdkey.fromMasterSeed(buffer);
      const childKey = key.derive('m/44\'/60\'/0\'/0/0');
      const privateKey = childKey.privateKey.toString('hex');
      await vscodeEnvironment.writeToClipboard(privateKey);
      window.showInformationMessage(Constants.informationMessage.privateKeyWasCopiedToClipboard);
    } catch (error) {
      window.showErrorMessage(Constants.errorMessageStrings.InvalidMnemonic);
    }
  }
}

function getDefaultDeployDestinations(truffleConfigsUri: string, consortiumTreeManager: ConsortiumTreeManager)
  : IDeployDestination[] {
  return [
    {
      cmd: createNewDeploymentNetwork.bind(undefined, consortiumTreeManager, truffleConfigsUri),
      label: Constants.uiCommandStrings.CreateNewNetwork,
      networkId: '*',
    },
  ];
}

function getTruffleDeployDestinations(truffleConfigsUri: string): IDeployDestination[] {
  const deployDestination: IDeployDestination[] = [];
  const truffleConfig = new TruffleConfig(truffleConfigsUri);
  const networksFromConfig = truffleConfig.getNetworks();

  networksFromConfig.forEach((network: TruffleConfiguration.INetwork) => {
    const options = network.options;
    const url = `${options.provider ? options.provider.url : ''}` ||
      `${options.host ? options.host : ''}${options.port ? ':' + options.port : ''}`;

    deployDestination.push({
      cmd: getTruffleDeployFunction(url, network.name, truffleConfigsUri, network.options.network_id),
      consortiumId: options.consortium_id,
      cwd: path.dirname(truffleConfigsUri),
      description: url,
      detail: 'From truffle-config.js',
      label: network.name,
      networkId: options.network_id,
    });
  });

  return deployDestination;
}

function getConsortiumDeployDestinations(truffleConfigsUri: string, consortiumTreeManager: ConsortiumTreeManager)
  : IDeployDestination[] {
  const deployDestination: IDeployDestination[] = [];
  const networks = consortiumTreeManager.getItems(true);

  networks.forEach((network) => {
    network.getChildren().forEach((child) => {
      const consortium = child as Consortium;
      const urls = consortium.getUrls().map((url) => format(url)).join(', ');

      deployDestination.push({
        cmd: getConsortiumCreateFunction(urls, consortium, truffleConfigsUri),
        consortiumId: consortium.getConsortiumId(),
        description: urls,
        detail: 'Consortium',
        label: consortium.label,
        networkId: '*',
      });
    });
  });

  return deployDestination;
}

function getTruffleDeployFunction(url: string, name: string, truffleConfigPath: string, networkId: number | string)
  : () => Promise<void> {
  // At this moment ganache-cli start only on port 8545.
  // Refactor this after the build
  if (url.match(localGanacheRegexp)) {
    return deployToLocalGanache.bind(undefined, name, truffleConfigPath, url);
  }
  // 1 - is the marker of main network
  if (networkId === 1 || networkId === '1') {
    return deployToMainNetwork.bind(undefined, name, truffleConfigPath);
  }
  return deployToNetwork.bind(undefined, name, truffleConfigPath);
}

function getConsortiumCreateFunction(url: string, consortium: Consortium, truffleConfigPath: string)
  : () => Promise<void> {
  // At this moment ganache-cli start only on port 8545.
  // Refactor this after the build
  if (url.match(localGanacheRegexp)) {
    return createLocalGanacheNetwork.bind(undefined, consortium as LocalNetworkConsortium, truffleConfigPath);
  }
  if (consortium instanceof MainNetworkConsortium) {
    return createMainNetwork.bind(undefined, consortium, truffleConfigPath);
  }
  return createNetwork.bind(undefined, consortium, truffleConfigPath);
}

async function execute(deployDestination: IDeployDestination[]): Promise<void> {
  const command = await showQuickPick(
    deployDestination,
    {
      ignoreFocusOut: true,
      placeHolder: Constants.placeholders.selectDeployDestination,
    },
  );
  await command.cmd();
}

async function createNewDeploymentNetwork(consortiumTreeManager: ConsortiumTreeManager, truffleConfigPath: string)
  : Promise<void> {
  const consortium = await ConsortiumCommands.connectConsortium(consortiumTreeManager);

  await createNetwork(consortium, truffleConfigPath);
}

async function createNetwork(consortium: Consortium, truffleConfigPath: string): Promise<void> {
  const network = await consortium.getTruffleNetwork();
  const truffleConfig = new TruffleConfig(truffleConfigPath);
  truffleConfig.setNetworks(network);

  await deployToNetwork(network.name, truffleConfigPath);
}

async function createMainNetwork(consortium: Consortium, truffleConfigPath: string): Promise<void> {
  await showConfirmPaidOperationDialog();

  await createNetwork(consortium, truffleConfigPath);
}

async function deployToNetwork(networkName: string, truffleConfigPath: string): Promise<void> {
  return window.withProgress({
    location: ProgressLocation.Window,
    title: Constants.statusBarMessages.deployingContracts(networkName),
  }, async () => {
    const workspaceRoot = path.dirname(truffleConfigPath);

    await fs.ensureDir(workspaceRoot);
    await outputCommandHelper.executeCommand(
      workspaceRoot,
      'npx',
      'truffle', 'migrate', '--reset', '--network', networkName,
    );
  });
}

async function createLocalGanacheNetwork(consortium: LocalNetworkConsortium, truffleConfigPath: string): Promise<void> {
  const port = await consortium.getPort();

  await GanacheService.startGanacheServer(port!);

  await createNetwork(consortium, truffleConfigPath);
}

async function deployToLocalGanache(networkName: string, truffleConfigPath: string, url: string): Promise<void> {
  const port = GanacheService.getPortFromUrl(url);
  await GanacheService.startGanacheServer(port!);

  await deployToNetwork(networkName, truffleConfigPath);
}

async function deployToMainNetwork(networkName: string, truffleConfigPath: string): Promise<void> {
  await showConfirmPaidOperationDialog();

  await deployToNetwork(networkName, truffleConfigPath);
}

async function readCompiledContract(uri: Uri): Promise<any> {
  const contractUri = await TruffleCommands.acquireCompiledContractUri(uri);
  const data = fs.readFileSync(contractUri.fsPath, null);

  return JSON.parse(data.toString());
}