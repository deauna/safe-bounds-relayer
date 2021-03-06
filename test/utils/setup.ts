import { AddressZero } from '@ethersproject/constants'
import hre, { deployments } from 'hardhat'
import { Signer, Contract } from 'ethers'
import solc from 'solc'

export const transactionQueueDeployment = async () => {
  return await deployments.get('SafeTransactionQueueConditionalRefund')
}

export const transactionQueueContract = async () => {
  return await hre.ethers.getContractFactory('SafeTransactionQueueConditionalRefund')
}

export const getSafeAtAddress = async (address: string) => {
  const safeMock = await hre.ethers.getContractFactory('GnosisSafeMock')

  return safeMock.attach(address)
}

export const getTestSafe = async (deployer: Signer, moduleAddr?: string) => {
  const safeFactory = await hre.ethers.getContractFactory('GnosisSafeMock')
  const factoryWithDeployer = safeFactory.connect(deployer)
  const safe = factoryWithDeployer.deploy(moduleAddr || AddressZero)

  return safe
}

export const getTransactionQueueInstance = async () => {
  return (await transactionQueueContract()).attach((await transactionQueueDeployment()).address)
}

export const getTestStorageSetter = async (signer: Signer) => {
  const factory = await hre.ethers.getContractFactory('StorageSetter')
  const factoryWithDeployer = factory.connect(signer)
  const setter = await factoryWithDeployer.deploy()

  return setter
}

export const getStorageSetterAtAddress = async (address: string) => {
  const storageSetter = await hre.ethers.getContractFactory('StorageSetter')

  return storageSetter.attach(address)
}

export const compile = async (source: string) => {
  const input = JSON.stringify({
    language: 'Solidity',
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode'],
        },
      },
    },
    sources: {
      'tmp.sol': {
        content: source,
      },
    },
  })
  const solcData = await solc.compile(input)
  const output = JSON.parse(solcData)
  if (!output['contracts']) {
    console.log(output)
    throw Error('Could not compile contract')
  }
  const fileOutput = output['contracts']['tmp.sol']
  const contractOutput = fileOutput[Object.keys(fileOutput)[0]]
  const abi = contractOutput['abi']
  const data = '0x' + contractOutput['evm']['bytecode']['object']
  return {
    data: data,
    interface: abi,
  }
}

export const deployContract = async (deployer: Signer, source: string): Promise<Contract> => {
  const output = await compile(source)
  const transaction = await deployer.sendTransaction({ data: output.data, gasLimit: 6000000 })
  const receipt = await transaction.wait()
  return new Contract(receipt.contractAddress, output.interface, deployer)
}
